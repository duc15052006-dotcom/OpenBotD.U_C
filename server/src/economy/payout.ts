import {
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type AgentPnl,
} from "./model";
import type { AuditInitiator, AuditStore } from "../audit";
import {
  executeAndPersistAuthorizedPayment,
  PaymentExecutionRefusedError,
  type ExecutablePaymentIntent,
  type OwnerPaymentApproval,
  type PaymentAuthorization,
  type PaymentPolicySnapshot,
  type VerifiedPaymentReceipt,
  type VerifiedPaymentReceiptStore,
} from "./execution";
import type { PaymentAccountAdapter } from "./payment-adapter";
import type { PaymentIntentReader } from "./payment-intent-store";
import type { OwnerPayoutAccountingStore } from "./payout-store";

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
  receiptStore: VerifiedPaymentReceiptStore;
  intentReader: PaymentIntentReader;
  payoutStore: OwnerPayoutAccountingStore;
  requestedBy: string;
  audit: {
    store: AuditStore;
    actorUserId?: string;
    initiator?: AuditInitiator;
  };
  loadPolicySnapshot: () => Promise<PaymentPolicySnapshot>;
  loadOwnerApproval?: (
    approvalId: string,
  ) => Promise<OwnerPaymentApproval | null>;
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

  const receipt = await executeAndPersistAuthorizedPayment({
    intent,
    authorization: input.authorization,
    provider: input.provider,
    adapter: input.adapter,
    receiptStore: input.receiptStore,
    intentReader: input.intentReader,
    audit: input.audit,
    loadOwnerApproval: input.loadOwnerApproval,
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
  const persisted = await input.payoutStore.persist({
    intentId: input.intentId,
    agentId: input.agentId,
    accountId: input.accountId,
    payoutIdempotencyKey: input.idempotencyKey,
    assetCode: receipt.assetCode,
    assetClass: "STABLECOIN",
    amountMinor: receipt.amountMinor,
    destination: receipt.destination,
    distributableProfitBeforeMinor: pnl.distributableProfitBeforePayoutMinor,
    reserveBeforeMinor: pnl.reserveAllocationMinor,
    policyVersion: input.authorization.policyVersion,
    requestedBy: input.requestedBy,
    approval: input.authorization.decision,
    externalReference: receipt.externalReference,
    paidAt: occurredAt,
  });

  return {
    receipt,
    pnlBeforePayout: pnl,
    ledgerEntry: persisted.ledgerEntry,
  };
}
