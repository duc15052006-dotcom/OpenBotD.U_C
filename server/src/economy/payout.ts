import {
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type AgentPnl,
} from "./model";
import {
  executeAuthorizedPayment,
  PaymentExecutionRefusedError,
  type ExecutablePaymentIntent,
  type PaymentAuthorization,
  type PaymentPolicySnapshot,
  type VerifiedPaymentReceipt,
} from "./execution";
import type { PaymentAccountAdapter } from "./payment-adapter";

export interface ManualOwnerPayoutResult {
  receipt: VerifiedPaymentReceipt;
  pnlBeforePayout: AgentPnl;
  ledgerEntry: AgentLedgerEntry;
}

function minimum(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Execute a manual Owner payout only after proving distributable profit from immutable ledger input.
 *
 * The policy snapshot is still re-read by executeAuthorizedPayment immediately before external
 * execution. The ledger proof only narrows what may be paid; it never expands a policy allowance.
 */
export async function executeManualOwnerPayout(input: {
  intentId: string;
  idempotencyKey: string;
  agentId: string;
  accountId: string;
  assetCode: string;
  amountMinor: bigint;
  destination: string;
  provider: string;
  authorization: PaymentAuthorization;
  ledgerEntries: readonly AgentLedgerEntry[];
  adapter: PaymentAccountAdapter;
  loadPolicySnapshot: () => Promise<PaymentPolicySnapshot>;
  occurredAt?: Date;
}): Promise<ManualOwnerPayoutResult> {
  const pnl = summarizeAgentLedger(input.agentId, input.ledgerEntries);

  if (input.amountMinor <= 0n) {
    throw new PaymentExecutionRefusedError(
      "Owner payout amount must be positive",
    );
  }
  if (input.amountMinor > pnl.availableDistributableProfitMinor) {
    throw new PaymentExecutionRefusedError(
      "Owner payout exceeds ledger-proven distributable profit",
    );
  }

  const intent: ExecutablePaymentIntent = {
    id: input.intentId,
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    assetCode: input.assetCode,
    agentId: input.agentId,
    kind: "OWNER_PAYOUT",
    amountMinor: input.amountMinor,
    destination: input.destination,
    category: "owner_payout",
  };

  const receipt = await executeAuthorizedPayment({
    intent,
    authorization: input.authorization,
    provider: input.provider,
    adapter: input.adapter,
    loadPolicySnapshot: async () => {
      const snapshot = await input.loadPolicySnapshot();
      return {
        ...snapshot,
        availableDistributableProfitMinor: minimum(
          snapshot.availableDistributableProfitMinor,
          pnl.availableDistributableProfitMinor,
        ),
      };
    },
  });

  const occurredAt = input.occurredAt ?? receipt.verifiedAt;
  const ledgerEntry: AgentLedgerEntry = {
    id: `owner-payout:${receipt.externalReference}`,
    agentId: input.agentId,
    accountId: input.accountId,
    idempotencyKey: `ledger:${input.idempotencyKey}`,
    type: "owner_payout",
    direction: "debit",
    status: "settled",
    amountMinor: receipt.amountMinor,
    assetCode: receipt.assetCode,
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt,
  };

  return { receipt, pnlBeforePayout: pnl, ledgerEntry };
}
