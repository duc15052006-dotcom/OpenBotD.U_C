import { describe, expect, test } from "bun:test";
import {
  childFundingRemaining,
  childProfitMinor,
  childRoiBasisPoints,
  decideChildFunding,
  type ChildFundingRelationship,
} from "../src/economy/child-funding";

const relationship: ChildFundingRelationship = {
  parentAgentId: "parent",
  childAgentId: "child",
  budgetMinor: 50_000n,
  spentMinor: 10_000n,
  revenueMinor: 30_000n,
  operatingCostMinor: 12_000n,
  fundedMinor: 20_000n,
  active: true,
  frozen: false,
};

describe("Agent Economy child funding", () => {
  test("tracks remaining budget, child profit and ROI", () => {
    expect(childFundingRemaining(relationship)).toBe(40_000n);
    expect(childProfitMinor(relationship)).toBe(18_000n);
    expect(childRoiBasisPoints(relationship)).toBe(9_000n);
  });

  test("returns N/A ROI when there is no investment basis", () => {
    expect(childRoiBasisPoints({ ...relationship, fundedMinor: 0n })).toBeNull();
  });

  test("allows funding only inside child budget, parent reserve and policy cap", () => {
    expect(
      decideChildFunding({
        relationship,
        amountMinor: 5_000n,
        maxChildFundingMinor: 10_000n,
        parentSettledBalanceMinor: 50_000n,
        parentMinimumReserveMinor: 20_000n,
      }),
    ).toEqual({
      allowed: true,
      amountMinor: 5_000n,
      reason: "child funding is eligible for Economy policy execution",
    });
  });

  test("freeze blocks funding without disabling the child runtime", () => {
    expect(
      decideChildFunding({
        relationship: { ...relationship, frozen: true },
        amountMinor: 5_000n,
        maxChildFundingMinor: 10_000n,
        parentSettledBalanceMinor: 50_000n,
        parentMinimumReserveMinor: 20_000n,
      }),
    ).toMatchObject({ allowed: false, reason: "child funding is frozen" });
  });

  test("cannot exceed relationship budget", () => {
    expect(
      decideChildFunding({
        relationship,
        amountMinor: 40_001n,
        maxChildFundingMinor: 100_000n,
        parentSettledBalanceMinor: 100_000n,
        parentMinimumReserveMinor: 20_000n,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "funding exceeds child budget",
    });
  });

  test("cannot breach the parent's reserve", () => {
    expect(
      decideChildFunding({
        relationship,
        amountMinor: 10_000n,
        maxChildFundingMinor: 10_000n,
        parentSettledBalanceMinor: 25_000n,
        parentMinimumReserveMinor: 20_000n,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "funding would breach parent minimum reserve",
    });
  });

  test("parent cannot fund itself as a child relationship", () => {
    expect(
      decideChildFunding({
        relationship: { ...relationship, childAgentId: "parent" },
        amountMinor: 1_000n,
        maxChildFundingMinor: 10_000n,
        parentSettledBalanceMinor: 50_000n,
        parentMinimumReserveMinor: 20_000n,
      }),
    ).toMatchObject({ allowed: false, reason: "parent and child must differ" });
  });
});
