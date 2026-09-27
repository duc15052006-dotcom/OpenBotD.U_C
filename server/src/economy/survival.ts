export type SurvivalState =
  | "HEALTHY"
  | "LOW_RESERVE"
  | "CRITICAL"
  | "FROZEN"
  | "INSOLVENT";

export type ModelCostMode = "standard" | "economy" | "minimal";

export interface SurvivalControls {
  state: SurvivalState;
  modelCostMode: ModelCostMode;
  allowOptionalSpend: boolean;
  allowChildFunding: boolean;
  alertOwner: boolean;
  prioritizeRevenueWork: boolean;
  reason: string;
}

export function evaluateSurvivalControls(input: {
  settledBalanceMinor: bigint;
  minimumReserveMinor: bigint;
  frozen: boolean;
}): SurvivalControls {
  if (input.minimumReserveMinor < 0n) {
    throw new Error("minimum reserve must not be negative");
  }

  if (input.frozen) {
    return {
      state: "FROZEN",
      modelCostMode: "minimal",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
      prioritizeRevenueWork: true,
      reason: "financial activity is frozen",
    };
  }

  if (input.settledBalanceMinor <= 0n) {
    return {
      state: "INSOLVENT",
      modelCostMode: "minimal",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
      prioritizeRevenueWork: true,
      reason: "settled balance is exhausted",
    };
  }

  if (
    input.minimumReserveMinor > 0n &&
    input.settledBalanceMinor * 2n < input.minimumReserveMinor
  ) {
    return {
      state: "CRITICAL",
      modelCostMode: "minimal",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
      prioritizeRevenueWork: true,
      reason: "settled balance is below half of minimum reserve",
    };
  }

  if (
    input.minimumReserveMinor > 0n &&
    input.settledBalanceMinor <= input.minimumReserveMinor
  ) {
    return {
      state: "LOW_RESERVE",
      modelCostMode: "economy",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
      prioritizeRevenueWork: true,
      reason: "settled balance is at or below minimum reserve",
    };
  }

  return {
    state: "HEALTHY",
    modelCostMode: "standard",
    allowOptionalSpend: true,
    allowChildFunding: true,
    alertOwner: false,
    prioritizeRevenueWork: false,
    reason: "reserve requirements are satisfied",
  };
}

export function financeHeartbeatWorkKey(
  agentId: string,
  scheduledFor: Date,
): string {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) throw new Error("Agent id is required");
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new Error("finance heartbeat time is invalid");
  }

  return `${normalizedAgentId}:${scheduledFor.toISOString()}`;
}
