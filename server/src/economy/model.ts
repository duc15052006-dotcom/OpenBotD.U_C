export const SHARE_BASIS_POINTS = 10_000n;

export type AssetClass =
  | "FIAT"
  | "STABLECOIN"
  | "CRYPTO_OTHER"
  | "COMPUTE_CREDIT"
  | "INTERNAL_CREDIT"
  | "RECEIVABLE"
  | "PAYABLE";

export type LedgerEntryType =
  | "revenue"
  | "operating_cost"
  | "reserve_allocation"
  | "reinvestment"
  | "owner_payout"
  | "investment"
  | "adjustment";

export type LedgerDirection = "credit" | "debit";
export type LedgerStatus = "pending" | "settled" | "failed" | "reversed";

export interface AgentLedgerEntry {
  id: string;
  agentId: string;
  accountId: string;
  idempotencyKey: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  status: LedgerStatus;
  amountMinor: bigint;
  assetCode: string;
  assetClass: AssetClass;
  redeemable: boolean;
  occurredAt: Date;
}

export interface TreasuryPolicy {
  ownerShareBps: bigint;
  reinvestmentShareBps: bigint;
  reserveShareBps: bigint;
  minimumReserveMinor: bigint;
  maxPaymentPerTransactionMinor: bigint;
  maxHourlySpendMinor: bigint;
  maxDailySpendMinor: bigint;
  maxMonthlySpendMinor: bigint;
  ownerConfirmationThresholdMinor: bigint;
  allowedPaymentAddresses: readonly string[];
  allowedPaymentCategories: readonly string[];
  frozen: boolean;
}

export type FinancialState =
  | "HEALTHY"
  | "LOW_RESERVE"
  | "CRITICAL"
  | "PROFITABLE"
  | "PAYOUT_READY"
  | "FROZEN"
  | "INSOLVENT";

export interface AgentPnl {
  grossRevenueMinor: bigint;
  operatingCostMinor: bigint;
  operatingProfitMinor: bigint;
  reserveAllocationMinor: bigint;
  reinvestmentMinor: bigint;
  distributableProfitBeforePayoutMinor: bigint;
  ownerPayoutMinor: bigint;
  availableDistributableProfitMinor: bigint;
  totalInvestmentMinor: bigint;
  roiBasisPoints: bigint | null;
}

export interface ProfitAllocation {
  ownerMinor: bigint;
  reinvestmentMinor: bigint;
  reserveMinor: bigint;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function validateTreasuryPolicy(policy: TreasuryPolicy): string[] {
  const errors: string[] = [];
  const shares =
    policy.ownerShareBps +
    policy.reinvestmentShareBps +
    policy.reserveShareBps;

  if (shares !== SHARE_BASIS_POINTS) {
    errors.push("profit shares must add up to 10000 basis points");
  }

  for (const [name, value] of [
    ["ownerShareBps", policy.ownerShareBps],
    ["reinvestmentShareBps", policy.reinvestmentShareBps],
    ["reserveShareBps", policy.reserveShareBps],
    ["minimumReserveMinor", policy.minimumReserveMinor],
    ["maxPaymentPerTransactionMinor", policy.maxPaymentPerTransactionMinor],
    ["maxHourlySpendMinor", policy.maxHourlySpendMinor],
    ["maxDailySpendMinor", policy.maxDailySpendMinor],
    ["maxMonthlySpendMinor", policy.maxMonthlySpendMinor],
    [
      "ownerConfirmationThresholdMinor",
      policy.ownerConfirmationThresholdMinor,
    ],
  ] as const) {
    if (value < 0n) errors.push(`${name} must not be negative`);
  }

  if (
    policy.maxHourlySpendMinor > policy.maxDailySpendMinor ||
    policy.maxDailySpendMinor > policy.maxMonthlySpendMinor
  ) {
    errors.push("spend windows must be monotonic: hourly <= daily <= monthly");
  }

  return errors;
}

export function allocateOperatingProfit(
  operatingProfitMinor: bigint,
  policy: TreasuryPolicy,
): ProfitAllocation {
  const errors = validateTreasuryPolicy(policy);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const profit = nonNegative(operatingProfitMinor);
  const ownerMinor =
    (profit * policy.ownerShareBps) / SHARE_BASIS_POINTS;
  const reinvestmentMinor =
    (profit * policy.reinvestmentShareBps) / SHARE_BASIS_POINTS;
  // Put rounding remainder into reserve rather than accidentally making it
  // distributable to the Owner.
  const reserveMinor = profit - ownerMinor - reinvestmentMinor;

  return { ownerMinor, reinvestmentMinor, reserveMinor };
}

export function summarizeAgentLedger(
  agentId: string,
  entries: readonly AgentLedgerEntry[],
): AgentPnl {
  let grossRevenueMinor = 0n;
  let operatingCostMinor = 0n;
  let reserveAllocationMinor = 0n;
  let reinvestmentMinor = 0n;
  let ownerPayoutMinor = 0n;
  let totalInvestmentMinor = 0n;

  for (const entry of entries) {
    if (entry.agentId !== agentId) {
      throw new Error(
        `ledger entry ${entry.id} belongs to another agent; cross-agent aggregation is forbidden`,
      );
    }
    if (entry.amountMinor <= 0n) {
      throw new Error(`ledger entry ${entry.id} must have a positive amount`);
    }
    if (entry.status !== "settled") continue;

    switch (entry.type) {
      case "revenue":
        if (entry.direction !== "credit") {
          throw new Error(`revenue entry ${entry.id} must be a credit`);
        }
        grossRevenueMinor += entry.amountMinor;
        break;
      case "operating_cost":
        if (entry.direction !== "debit") {
          throw new Error(`operating cost entry ${entry.id} must be a debit`);
        }
        operatingCostMinor += entry.amountMinor;
        break;
      case "reserve_allocation":
        reserveAllocationMinor += entry.amountMinor;
        break;
      case "reinvestment":
        reinvestmentMinor += entry.amountMinor;
        break;
      case "owner_payout":
        if (entry.direction !== "debit") {
          throw new Error(`owner payout entry ${entry.id} must be a debit`);
        }
        ownerPayoutMinor += entry.amountMinor;
        break;
      case "investment":
        if (entry.direction !== "credit") {
          throw new Error(`investment entry ${entry.id} must be a credit`);
        }
        totalInvestmentMinor += entry.amountMinor;
        break;
      case "adjustment":
        break;
    }
  }

  const operatingProfitMinor = grossRevenueMinor - operatingCostMinor;
  const distributableProfitBeforePayoutMinor = nonNegative(
    operatingProfitMinor - reserveAllocationMinor - reinvestmentMinor,
  );
  const availableDistributableProfitMinor = nonNegative(
    distributableProfitBeforePayoutMinor - ownerPayoutMinor,
  );
  const roiBasisPoints =
    totalInvestmentMinor === 0n
      ? null
      : (operatingProfitMinor * SHARE_BASIS_POINTS) / totalInvestmentMinor;

  return {
    grossRevenueMinor,
    operatingCostMinor,
    operatingProfitMinor,
    reserveAllocationMinor,
    reinvestmentMinor,
    distributableProfitBeforePayoutMinor,
    ownerPayoutMinor,
    availableDistributableProfitMinor,
    totalInvestmentMinor,
    roiBasisPoints,
  };
}

export function financialState(input: {
  settledBalanceMinor: bigint;
  minimumReserveMinor: bigint;
  availableDistributableProfitMinor: bigint;
  operatingProfitMinor: bigint;
  frozen: boolean;
}): FinancialState {
  if (input.frozen) return "FROZEN";
  if (input.settledBalanceMinor <= 0n) return "INSOLVENT";

  if (input.minimumReserveMinor > 0n) {
    if (input.settledBalanceMinor * 2n < input.minimumReserveMinor) {
      return "CRITICAL";
    }
    if (input.settledBalanceMinor <= input.minimumReserveMinor) {
      return "LOW_RESERVE";
    }
  }

  if (input.availableDistributableProfitMinor > 0n) return "PAYOUT_READY";
  if (input.operatingProfitMinor > 0n) return "PROFITABLE";
  return "HEALTHY";
}

export function canOwnerPayout(input: {
  amountMinor: bigint;
  settledBalanceMinor: bigint;
  availableDistributableProfitMinor: bigint;
  destination: string;
  policy: TreasuryPolicy;
}): { allowed: boolean; reason?: string } {
  const errors = validateTreasuryPolicy(input.policy);
  if (errors.length > 0) return { allowed: false, reason: errors.join("; ") };
  if (input.policy.frozen) {
    return { allowed: false, reason: "financial activity is frozen" };
  }
  if (input.amountMinor <= 0n) {
    return { allowed: false, reason: "payout amount must be positive" };
  }
  if (input.amountMinor > input.availableDistributableProfitMinor) {
    return { allowed: false, reason: "payout exceeds distributable profit" };
  }
  if (
    input.settledBalanceMinor - input.amountMinor <
    input.policy.minimumReserveMinor
  ) {
    return { allowed: false, reason: "payout would breach minimum reserve" };
  }
  if (
    input.policy.allowedPaymentAddresses.length > 0 &&
    !input.policy.allowedPaymentAddresses.includes(input.destination)
  ) {
    return { allowed: false, reason: "payout destination is not whitelisted" };
  }
  return { allowed: true };
}
