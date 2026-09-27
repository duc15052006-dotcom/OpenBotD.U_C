import {
  canOwnerPayout,
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type TreasuryPolicy,
} from "./model";
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
    },
  };
}
