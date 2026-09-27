export interface ChildFundingRelationship {
  id: string;
  parentAgentId: string;
  childAgentId: string;
  version: number;
  budgetMinor: bigint;
  assetCode: string;
  active: boolean;
  frozen: boolean;
}

export interface ChildFundingEvent {
  id: string;
  relationshipId: string;
  parentAgentId: string;
  childAgentId: string;
  amountMinor: bigint;
  assetCode: string;
}

export interface ChildEconomySummary {
  budgetMinor: bigint;
  fundedMinor: bigint;
  remainingBudgetMinor: bigint;
  grossRevenueMinor: bigint;
  operatingCostMinor: bigint;
  operatingProfitMinor: bigint;
  roiBasisPoints: bigint | null;
}

export interface ChildFundingDecision {
  allowed: boolean;
  reason: string;
  remainingBudgetMinor: bigint;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function summarizeChildEconomy(input: {
  relationship: ChildFundingRelationship;
  fundingEvents: readonly ChildFundingEvent[];
  grossRevenueMinor: bigint;
  operatingCostMinor: bigint;
}): ChildEconomySummary {
  const { relationship } = input;

  if (relationship.parentAgentId === relationship.childAgentId) {
    throw new Error("parent and child Agent must be different");
  }
  if (relationship.budgetMinor < 0n) {
    throw new Error("child funding budget must not be negative");
  }
  if (input.grossRevenueMinor < 0n || input.operatingCostMinor < 0n) {
    throw new Error("child economy inputs must not be negative");
  }

  let fundedMinor = 0n;
  for (const event of input.fundingEvents) {
    if (event.relationshipId !== relationship.id) {
      throw new Error(
        `funding event ${event.id} belongs to another relationship`,
      );
    }
    if (
      event.parentAgentId !== relationship.parentAgentId ||
      event.childAgentId !== relationship.childAgentId
    ) {
      throw new Error(
        `funding event ${event.id} crosses the relationship Agent boundary`,
      );
    }
    if (event.assetCode !== relationship.assetCode) {
      throw new Error(
        `funding event ${event.id} uses another relationship asset`,
      );
    }
    if (event.amountMinor <= 0n) {
      throw new Error(`funding event ${event.id} must be positive`);
    }
    fundedMinor += event.amountMinor;
  }

  const operatingProfitMinor =
    input.grossRevenueMinor - input.operatingCostMinor;
  const remainingBudgetMinor = nonNegative(
    relationship.budgetMinor - fundedMinor,
  );
  const roiBasisPoints =
    fundedMinor === 0n
      ? null
      : (operatingProfitMinor * 10_000n) / fundedMinor;

  return {
    budgetMinor: relationship.budgetMinor,
    fundedMinor,
    remainingBudgetMinor,
    grossRevenueMinor: input.grossRevenueMinor,
    operatingCostMinor: input.operatingCostMinor,
    operatingProfitMinor,
    roiBasisPoints,
  };
}

export function evaluateChildFunding(input: {
  relationship: ChildFundingRelationship;
  amountMinor: bigint;
  fundedToDateMinor: bigint;
  maxChildFundingMinor: bigint;
}): ChildFundingDecision {
  const { relationship } = input;

  if (relationship.parentAgentId === relationship.childAgentId) {
    return {
      allowed: false,
      reason: "parent and child Agent must be different",
      remainingBudgetMinor: 0n,
    };
  }
  if (!relationship.active) {
    return {
      allowed: false,
      reason: "child funding relationship is inactive",
      remainingBudgetMinor: nonNegative(
        relationship.budgetMinor - input.fundedToDateMinor,
      ),
    };
  }
  if (relationship.frozen) {
    return {
      allowed: false,
      reason: "child funding relationship is frozen",
      remainingBudgetMinor: nonNegative(
        relationship.budgetMinor - input.fundedToDateMinor,
      ),
    };
  }
  if (
    relationship.budgetMinor < 0n ||
    input.fundedToDateMinor < 0n ||
    input.maxChildFundingMinor < 0n
  ) {
    return {
      allowed: false,
      reason: "child funding policy contains a negative limit",
      remainingBudgetMinor: 0n,
    };
  }
  if (input.amountMinor <= 0n) {
    return {
      allowed: false,
      reason: "child funding amount must be positive",
      remainingBudgetMinor: nonNegative(
        relationship.budgetMinor - input.fundedToDateMinor,
      ),
    };
  }

  const remainingBudgetMinor = nonNegative(
    relationship.budgetMinor - input.fundedToDateMinor,
  );

  if (input.amountMinor > input.maxChildFundingMinor) {
    return {
      allowed: false,
      reason: "child funding exceeds Agent policy limit",
      remainingBudgetMinor,
    };
  }
  if (input.amountMinor > remainingBudgetMinor) {
    return {
      allowed: false,
      reason: "child funding exceeds relationship budget",
      remainingBudgetMinor,
    };
  }

  return {
    allowed: true,
    reason: "child funding relationship allows request",
    remainingBudgetMinor: remainingBudgetMinor - input.amountMinor,
  };
}
