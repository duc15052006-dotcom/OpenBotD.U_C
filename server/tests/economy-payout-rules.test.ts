import { describe, expect, test } from "bun:test";
import {
  evaluateAutomatedPayout,
  scheduledPayoutWorkKey,
  type AutomatedPayoutRule,
} from "../src/economy/payout-rules";

const thresholdRule: AutomatedPayoutRule = {
  id: "rule-1",
  agentId: "agent-a",
  mode: "threshold",
  enabled: true,
  thresholdMinor: 10_000n,
  maxPayoutMinor: 20_000n,
};

describe("Agent Economy automated payout rules", () => {
  test("offers only reserve-safe distributable profit to E5a", () => {
    expect(
      evaluateAutomatedPayout({
        rule: thresholdRule,
        availableDistributableProfitMinor: 30_000n,
        settledBalanceMinor: 25_000n,
        minimumReserveMinor: 10_000n,
      }),
    ).toEqual({
      eligible: true,
      amountMinor: 15_000n,
      reason: "payout rule is eligible for E5a execution",
    });
  });

  test("does not trigger threshold payout below threshold", () => {
    expect(
      evaluateAutomatedPayout({
        rule: thresholdRule,
        availableDistributableProfitMinor: 9_999n,
        settledBalanceMinor: 50_000n,
        minimumReserveMinor: 10_000n,
      }),
    ).toEqual({
      eligible: false,
      amountMinor: 0n,
      reason: "distributable profit is below payout threshold",
    });
  });

  test("scheduled payout cannot run before its due time", () => {
    expect(
      evaluateAutomatedPayout({
        rule: { ...thresholdRule, mode: "scheduled" },
        availableDistributableProfitMinor: 20_000n,
        settledBalanceMinor: 50_000n,
        minimumReserveMinor: 10_000n,
        scheduledFor: new Date("2026-09-28T00:00:00Z"),
        now: new Date("2026-09-27T00:00:00Z"),
      }),
    ).toEqual({
      eligible: false,
      amountMinor: 0n,
      reason: "scheduled payout is not due yet",
    });
  });

  test("maximum payout caps an otherwise larger eligible amount", () => {
    expect(
      evaluateAutomatedPayout({
        rule: thresholdRule,
        availableDistributableProfitMinor: 50_000n,
        settledBalanceMinor: 100_000n,
        minimumReserveMinor: 10_000n,
      }),
    ).toMatchObject({ eligible: true, amountMinor: 20_000n });
  });

  test("disabled rule cannot enqueue a payout", () => {
    expect(
      evaluateAutomatedPayout({
        rule: { ...thresholdRule, enabled: false },
        availableDistributableProfitMinor: 50_000n,
        settledBalanceMinor: 100_000n,
        minimumReserveMinor: 10_000n,
      }),
    ).toMatchObject({ eligible: false, amountMinor: 0n });
  });

  test("durable scheduled work key is deterministic per due time", () => {
    const due = new Date("2026-09-28T09:00:00Z");
    expect(scheduledPayoutWorkKey("rule-1", due)).toBe(
      "rule-1:2026-09-28T09:00:00.000Z",
    );
    expect(scheduledPayoutWorkKey("rule-1", due)).toBe(
      scheduledPayoutWorkKey("rule-1", due),
    );
  });
});
