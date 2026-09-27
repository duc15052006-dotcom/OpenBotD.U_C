import { describe, expect, test } from "bun:test";
import {
  evaluateSurvivalControls,
  financeHeartbeatWorkKey,
} from "../src/economy/survival";

describe("Agent Economy survival controls", () => {
  test("healthy finance keeps normal capabilities", () => {
    expect(
      evaluateSurvivalControls({
        settledBalanceMinor: 20_000n,
        minimumReserveMinor: 10_000n,
        frozen: false,
      }),
    ).toEqual({
      state: "HEALTHY",
      modelCostMode: "standard",
      allowOptionalSpend: true,
      allowChildFunding: true,
      alertOwner: false,
      prioritizeRevenueWork: false,
      reason: "reserve requirements are satisfied",
    });
  });

  test("low reserve downgrades model cost and suppresses optional spend", () => {
    expect(
      evaluateSurvivalControls({
        settledBalanceMinor: 10_000n,
        minimumReserveMinor: 10_000n,
        frozen: false,
      }),
    ).toEqual({
      state: "LOW_RESERVE",
      modelCostMode: "economy",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
      prioritizeRevenueWork: true,
      reason: "settled balance is at or below minimum reserve",
    });
  });

  test("critical reserve and insolvency choose minimal cost mode", () => {
    expect(
      evaluateSurvivalControls({
        settledBalanceMinor: 4_999n,
        minimumReserveMinor: 10_000n,
        frozen: false,
      }).state,
    ).toBe("CRITICAL");

    expect(
      evaluateSurvivalControls({
        settledBalanceMinor: 0n,
        minimumReserveMinor: 10_000n,
        frozen: false,
      }),
    ).toMatchObject({
      state: "INSOLVENT",
      modelCostMode: "minimal",
      allowOptionalSpend: false,
      allowChildFunding: false,
      alertOwner: true,
    });
  });

  test("financial freeze overrides an otherwise healthy balance", () => {
    expect(
      evaluateSurvivalControls({
        settledBalanceMinor: 1_000_000n,
        minimumReserveMinor: 10_000n,
        frozen: true,
      }).state,
    ).toBe("FROZEN");
  });

  test("heartbeat key is deterministic for durable work idempotence", () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    expect(financeHeartbeatWorkKey("agent-a", at)).toBe(
      "agent-a:2026-09-27T12:00:00.000Z",
    );
    expect(financeHeartbeatWorkKey(" agent-a ", at)).toBe(
      "agent-a:2026-09-27T12:00:00.000Z",
    );
  });
});
