import { describe, expect, test } from "bun:test";
import {
  evaluateChildFunding,
  summarizeChildEconomy,
  type ChildFundingEvent,
  type ChildFundingRelationship,
} from "../src/economy/child-economy";

const relationship: ChildFundingRelationship = {
  id: "relationship-1",
  parentAgentId: "parent",
  childAgentId: "child",
  version: 1,
  budgetMinor: 100_000n,
  assetCode: "USDC",
  active: true,
  frozen: false,
};

function event(id: string, amountMinor: bigint): ChildFundingEvent {
  return {
    id,
    relationshipId: relationship.id,
    parentAgentId: relationship.parentAgentId,
    childAgentId: relationship.childAgentId,
    amountMinor,
    assetCode: relationship.assetCode,
  };
}

describe("Agent Economy child funding", () => {
  test("derives child budget, profit and ROI from immutable events", () => {
    const summary = summarizeChildEconomy({
      relationship,
      fundingEvents: [event("one", 25_000n), event("two", 15_000n)],
      grossRevenueMinor: 60_000n,
      operatingCostMinor: 20_000n,
    });

    expect(summary).toEqual({
      budgetMinor: 100_000n,
      fundedMinor: 40_000n,
      remainingBudgetMinor: 60_000n,
      grossRevenueMinor: 60_000n,
      operatingCostMinor: 20_000n,
      operatingProfitMinor: 40_000n,
      roiBasisPoints: 10_000n,
    });
  });

  test("reports ROI as N/A when no investment has been funded", () => {
    expect(
      summarizeChildEconomy({
        relationship,
        fundingEvents: [],
        grossRevenueMinor: 5_000n,
        operatingCostMinor: 1_000n,
      }).roiBasisPoints,
    ).toBeNull();
  });

  test("refuses events crossing another relationship or Agent boundary", () => {
    expect(() =>
      summarizeChildEconomy({
        relationship,
        fundingEvents: [
          { ...event("foreign", 100n), relationshipId: "relationship-2" },
        ],
        grossRevenueMinor: 0n,
        operatingCostMinor: 0n,
      }),
    ).toThrow("belongs to another relationship");
  });

  test("freeze stops new funding without erasing prior funding", () => {
    expect(
      evaluateChildFunding({
        relationship: { ...relationship, frozen: true },
        amountMinor: 1_000n,
        fundedToDateMinor: 25_000n,
        maxChildFundingMinor: 10_000n,
      }),
    ).toEqual({
      allowed: false,
      reason: "child funding relationship is frozen",
      remainingBudgetMinor: 75_000n,
    });
  });

  test("enforces both per-request policy and relationship budget", () => {
    expect(
      evaluateChildFunding({
        relationship,
        amountMinor: 11_000n,
        fundedToDateMinor: 25_000n,
        maxChildFundingMinor: 10_000n,
      }),
    ).toEqual({
      allowed: false,
      reason: "child funding exceeds Agent policy limit",
      remainingBudgetMinor: 75_000n,
    });

    expect(
      evaluateChildFunding({
        relationship,
        amountMinor: 6_000n,
        fundedToDateMinor: 95_000n,
        maxChildFundingMinor: 10_000n,
      }),
    ).toEqual({
      allowed: false,
      reason: "child funding exceeds relationship budget",
      remainingBudgetMinor: 5_000n,
    });
  });

  test("allows a request only within both limits", () => {
    expect(
      evaluateChildFunding({
        relationship,
        amountMinor: 5_000n,
        fundedToDateMinor: 25_000n,
        maxChildFundingMinor: 10_000n,
      }),
    ).toEqual({
      allowed: true,
      reason: "child funding relationship allows request",
      remainingBudgetMinor: 70_000n,
    });
  });
});
