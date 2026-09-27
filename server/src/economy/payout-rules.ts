export type AutomatedPayoutMode = "threshold" | "scheduled";

export interface AutomatedPayoutRule {
  id: string;
  agentId: string;
  mode: AutomatedPayoutMode;
  enabled: boolean;
  thresholdMinor: bigint;
  maxPayoutMinor: bigint | null;
}

export interface AutomatedPayoutEvaluation {
  eligible: boolean;
  amountMinor: bigint;
  reason: string;
}

function minimum(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Decide whether an automated payout may be offered to the manual payout path.
 *
 * This function never executes money movement. The returned amount must still pass the E5a ledger
 * proof and E3 policy/execution checks at the moment money moves.
 */
export function evaluateAutomatedPayout(input: {
  rule: AutomatedPayoutRule;
  availableDistributableProfitMinor: bigint;
  settledBalanceMinor: bigint;
  minimumReserveMinor: bigint;
  scheduledFor?: Date;
  now?: Date;
}): AutomatedPayoutEvaluation {
  const { rule } = input;

  if (!rule.enabled) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "payout rule is disabled",
    };
  }
  if (rule.thresholdMinor < 0n) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "invalid payout threshold",
    };
  }
  if (rule.maxPayoutMinor !== null && rule.maxPayoutMinor <= 0n) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "invalid maximum payout",
    };
  }
  if (input.minimumReserveMinor < 0n) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "invalid minimum reserve",
    };
  }

  if (rule.mode === "scheduled") {
    if (!input.scheduledFor) {
      return {
        eligible: false,
        amountMinor: 0n,
        reason: "scheduled payout requires a due time",
      };
    }
    const now = input.now ?? new Date();
    if (input.scheduledFor.getTime() > now.getTime()) {
      return {
        eligible: false,
        amountMinor: 0n,
        reason: "scheduled payout is not due yet",
      };
    }
  }

  if (input.availableDistributableProfitMinor < rule.thresholdMinor) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "distributable profit is below payout threshold",
    };
  }

  const reserveSafeAmount =
    input.settledBalanceMinor > input.minimumReserveMinor
      ? input.settledBalanceMinor - input.minimumReserveMinor
      : 0n;
  let amountMinor = minimum(
    input.availableDistributableProfitMinor,
    reserveSafeAmount,
  );

  if (rule.maxPayoutMinor !== null) {
    amountMinor = minimum(amountMinor, rule.maxPayoutMinor);
  }

  if (amountMinor <= 0n) {
    return {
      eligible: false,
      amountMinor: 0n,
      reason: "no reserve-safe distributable profit is available",
    };
  }

  return {
    eligible: true,
    amountMinor,
    reason: "payout rule is eligible for E5a execution",
  };
}

export function scheduledPayoutWorkKey(
  ruleId: string,
  scheduledFor: Date,
): string {
  if (!ruleId.trim()) throw new Error("payout rule id is required");
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new Error("scheduled payout time is invalid");
  }
  return `${ruleId}:${scheduledFor.toISOString()}`;
}
