import {
  canOwnerPayout,
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type AssetClass,
  type TreasuryPolicy,
} from "./model";
import type { VerifiedPaymentReceipt } from "./execution";
import {
  decidePaymentIntent,
  type EconomyExecutionPolicy,
  type PaymentDecision,
  type PaymentIntent,
  type SpendWindow,
} from "./intents";

export interface OwnerPayoutProof {
  agentId: string;
  accountId: string;
  policyVersion: number;
  requestedMinor: bigint;
  settledBalanceMinor: bigint;
  balanceAfterMinor: bigint;
  operatingProfitMinor: bigint;
  distributableProfitBeforePayoutMinor: bigint;
  priorOwnerPayoutMinor: bigint;
  availableDistributableProfitMinor: bigint;
  minimumReserveMinor: bigint;
  destination: string;
  assetCode: string;
  assetClass: AssetClass;
}

export interface OwnerPayoutPlan {
  intent: PaymentIntent;
  decision: PaymentDecision;
  decisionReason: string;
  proof: OwnerPayoutProof;
}

export function planManualOwnerPayout(input: {
  agentId: string;
  accountId: string;
  policyVersion: number;
  amountMinor: bigint;
  destination: string;
  assetCode: string;
  assetClass: AssetClass;
  settledBalanceMinor: bigint;
  policy: EconomyExecutionPolicy;
  spend: SpendWindow;
  ledger: readonly AgentLedgerEntry[];
}): OwnerPayoutPlan {
  const pnl = summarizeAgentLedger(input.agentId, input.ledger);

  const payoutCheck = canOwnerPayout({
    amountMinor: input.amountMinor,
    settledBalanceMinor: input.settledBalanceMinor,
    availableDistributableProfitMinor:
      pnl.availableDistributableProfitMinor,
    destination: input.destination,
    policy: input.policy satisfies TreasuryPolicy,
  });
  if (!payoutCheck.allowed) {
    throw new Error(payoutCheck.reason ?? "owner payout is not allowed");
  }

  const intent: PaymentIntent = {
    agentId: input.agentId,
    kind: "OWNER_PAYOUT",
    amountMinor: input.amountMinor,
    destination: input.destination,
    category: "owner_payout",
  };

  const decision = decidePaymentIntent({
    intent,
    policy: input.policy,
    settledBalanceMinor: input.settledBalanceMinor,
    availableDistributableProfitMinor:
      pnl.availableDistributableProfitMinor,
    spend: input.spend,
  });
  if (decision.decision === "DENY") {
    throw new Error(decision.reason);
  }

  return {
    intent,
    decision: decision.decision,
    decisionReason: decision.reason,
    proof: {
      agentId: input.agentId,
      accountId: input.accountId,
      policyVersion: input.policyVersion,
      requestedMinor: input.amountMinor,
      settledBalanceMinor: input.settledBalanceMinor,
      balanceAfterMinor: input.settledBalanceMinor - input.amountMinor,
      operatingProfitMinor: pnl.operatingProfitMinor,
      distributableProfitBeforePayoutMinor:
        pnl.distributableProfitBeforePayoutMinor,
      priorOwnerPayoutMinor: pnl.ownerPayoutMinor,
      availableDistributableProfitMinor:
        pnl.availableDistributableProfitMinor,
      minimumReserveMinor: input.policy.minimumReserveMinor,
      destination: input.destination,
      assetCode: input.assetCode,
      assetClass: input.assetClass,
    },
  };
}

export interface CompletedOwnerPayout {
  agentId: string;
  accountId: string;
  intentId: string;
  externalReference: string;
  amountMinor: bigint;
  assetCode: string;
  destination: string;
  policyVersion: number;
  proof: OwnerPayoutProof;
  paidAt: Date;
}

export function completeOwnerPayout(input: {
  plan: OwnerPayoutPlan;
  receipt: VerifiedPaymentReceipt;
}): CompletedOwnerPayout {
  const { plan, receipt } = input;
  const proof = plan.proof;

  if (receipt.providerStatus !== "verified") {
    throw new Error("owner payout requires a verified payment receipt");
  }
  if (receipt.agentId !== proof.agentId || receipt.accountId !== proof.accountId) {
    throw new Error("owner payout receipt does not belong to the planned account");
  }
  if (receipt.amountMinor !== proof.requestedMinor) {
    throw new Error("owner payout receipt amount does not match the plan");
  }
  if (receipt.assetCode !== proof.assetCode) {
    throw new Error("owner payout receipt asset does not match the plan");
  }
  if (receipt.destination !== proof.destination) {
    throw new Error("owner payout receipt destination does not match the plan");
  }

  return {
    agentId: proof.agentId,
    accountId: proof.accountId,
    intentId: receipt.intentId,
    externalReference: receipt.externalReference,
    amountMinor: receipt.amountMinor,
    assetCode: receipt.assetCode,
    destination: receipt.destination,
    policyVersion: proof.policyVersion,
    proof,
    paidAt: receipt.verifiedAt,
  };
}

export function ownerPayoutLedgerEntry(
  payout: CompletedOwnerPayout,
): AgentLedgerEntry {
  const idempotencyKey = `owner-payout:${payout.externalReference}`;
  return {
    id: idempotencyKey,
    agentId: payout.agentId,
    accountId: payout.accountId,
    idempotencyKey,
    type: "owner_payout",
    direction: "debit",
    status: "settled",
    amountMinor: payout.amountMinor,
    assetCode: payout.assetCode,
    assetClass: payout.proof.assetClass,
    redeemable: true,
    occurredAt: payout.paidAt,
  };
}
