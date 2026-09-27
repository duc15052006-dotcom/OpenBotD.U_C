export interface ChildFundingRelationship {
  parentAgentId: string;
  childAgentId: string;
  budgetMinor: bigint;
  spentMinor: bigint;
  revenueMinor: bigint;
  operatingCostMinor: bigint;
  fundedMinor: bigint;
  active: boolean;
  frozen: boolean;
}

export interface ChildFundingDecision {
  allowed: boolean;
  amountMinor: bigint;
  reason: string;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function childFundingRemaining(
  relationship: ChildFundingRelationship,
): bigint {
  return nonNegative(relationship.budgetMinor - relationship.spentMinor);
}

export function childProfitMinor(
  relationship: ChildFundingRelationship,
): bigint {
  return relationship.revenueMinor - relationship.operatingCostMinor;
}

export function childRoiBasisPoints(
  relationship: ChildFundingRelationship,
): bigint | null {
  if (relationship.fundedMinor <= 0n) return null;
  return (childProfitMinor(relationship) * 10_000n) / relationship.fundedMinor;
}

/**
 * Evaluate a parent->child funding request without granting the child any wallet authority.
 *
 * The result is only an Economy intent candidate. The actual transfer must still pass E2/E3 policy,
 * reserve, whitelist and execution checks under the parent Agent's account.
 */
export function decideChildFunding(input: {
  relationship: ChildFundingRelationship;
  amountMinor: bigint;
  maxChildFundingMinor: bigint;
  parentSettledBalanceMinor: bigint;
  parentMinimumReserveMinor: bigint;
}): ChildFundingDecision {
  const { relationship } = input;

  if (relationship.parentAgentId === relationship.childAgentId) {
    return { allowed: false, amountMinor: 0n, reason: "parent and child must differ" };
  }
  if (!relationship.active) {
    return { allowed: false, amountMinor: 0n, reason: "child funding is inactive" };
  }
  if (relationship.frozen) {
    return { allowed: false, amountMinor: 0n, reason: "child funding is frozen" };
  }
  if (input.amountMinor <= 0n) {
    return { allowed: false, amountMinor: 0n, reason: "funding amount must be positive" };
  }
  if (input.maxChildFundingMinor < 0n) {
    return { allowed: false, amountMinor: 0n, reason: "invalid child funding limit" };
  }
  if (input.amountMinor > input.maxChildFundingMinor) {
    return { allowed: false, amountMinor: 0n, reason: "funding exceeds policy limit" };
  }

  const remaining = childFundingRemaining(relationship);
  if (input.amountMinor > remaining) {
    return { allowed: false, amountMinor: 0n, reason: "funding exceeds child budget" };
  }

  if (
    input.parentSettledBalanceMinor - input.amountMinor <
    input.parentMinimumReserveMinor
  ) {
    return {
      allowed: false,
      amountMinor: 0n,
      reason: "funding would breach parent minimum reserve",
    };
  }

  return {
    allowed: true,
    amountMinor: input.amountMinor,
    reason: "child funding is eligible for Economy policy execution",
  };
}
