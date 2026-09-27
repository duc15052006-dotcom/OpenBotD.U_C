import { describe, expect, test } from "bun:test";
import {
  allocateOperatingProfit,
  canOwnerPayout,
  financialState,
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type TreasuryPolicy,
} from "../src/economy/model";

const policy: TreasuryPolicy = {
  ownerShareBps: 5000n,
  reinvestmentShareBps: 3000n,
  reserveShareBps: 2000n,
  minimumReserveMinor: 10_000n,
  maxPaymentPerTransactionMinor: 100_000n,
  maxHourlySpendMinor: 100_000n,
  maxDailySpendMinor: 500_000n,
  maxMonthlySpendMinor: 5_000_000n,
  ownerConfirmationThresholdMinor: 10_000n,
  allowedPaymentAddresses: ["owner-wallet"],
  allowedPaymentCategories: ["owner_payout"],
  frozen: false,
};

function entry(
  id: string,
  type: AgentLedgerEntry["type"],
  direction: AgentLedgerEntry["direction"],
  amountMinor: bigint,
  status: AgentLedgerEntry["status"] = "settled",
): AgentLedgerEntry {
  return {
    id,
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: `idem-${id}`,
    type,
    direction,
    status,
    amountMinor,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  };
}

describe("Agent Economy accounting foundation", () => {
  test("keeps revenue distinct from profit and ignores unsettled events", () => {
    const pnl = summarizeAgentLedger("agent-a", [
      entry("revenue", "revenue", "credit", 50_000n),
      entry("pending", "revenue", "credit", 999_999n, "pending"),
      entry("ai", "operating_cost", "debit", 6_000n),
      entry("vm", "operating_cost", "debit", 2_500n),
      entry("api", "operating_cost", "debit", 1_500n),
      entry("reserve", "reserve_allocation", "debit", 10_000n),
      entry("reinvest", "reinvestment", "debit", 9_000n),
      entry("payout", "owner_payout", "debit", 20_000n),
      entry("investment", "investment", "credit", 25_000n),
    ]);

    expect(pnl.grossRevenueMinor).toBe(50_000n);
    expect(pnl.operatingCostMinor).toBe(10_000n);
    expect(pnl.operatingProfitMinor).toBe(40_000n);
    expect(pnl.distributableProfitBeforePayoutMinor).toBe(21_000n);
    expect(pnl.availableDistributableProfitMinor).toBe(1_000n);
    expect(pnl.roiBasisPoints).toBe(16_000n);
  });

  test("subtracts a settled revenue reversal from gross revenue", () => {
    const pnl = summarizeAgentLedger("agent-a", [
      entry("sale", "revenue", "credit", 50_000n),
      entry("refund", "revenue_reversal", "debit", 12_500n),
    ]);

    expect(pnl.grossRevenueMinor).toBe(37_500n);
    expect(pnl.operatingProfitMinor).toBe(37_500n);
  });

  test("refuses to aggregate finance across agents", () => {
    const foreign = {
      ...entry("foreign", "revenue", "credit", 100n),
      agentId: "agent-b",
    };
    expect(() => summarizeAgentLedger("agent-a", [foreign])).toThrow(
      "cross-agent aggregation is forbidden",
    );
  });

  test("allocates rounding remainder to reserve", () => {
    expect(allocateOperatingProfit(101n, policy)).toEqual({
      ownerMinor: 50n,
      reinvestmentMinor: 30n,
      reserveMinor: 21n,
    });
  });

  test("blocks owner payout that breaches reserve or whitelist", () => {
    expect(
      canOwnerPayout({
        amountMinor: 2_000n,
        settledBalanceMinor: 11_000n,
        availableDistributableProfitMinor: 5_000n,
        destination: "owner-wallet",
        policy,
      }),
    ).toEqual({
      allowed: false,
      reason: "payout would breach minimum reserve",
    });

    expect(
      canOwnerPayout({
        amountMinor: 1_000n,
        settledBalanceMinor: 20_000n,
        availableDistributableProfitMinor: 5_000n,
        destination: "other-wallet",
        policy,
      }),
    ).toEqual({
      allowed: false,
      reason: "payout destination is not whitelisted",
    });
  });

  test("financial states put freeze and solvency before profit", () => {
    expect(
      financialState({
        settledBalanceMinor: 100_000n,
        minimumReserveMinor: 10_000n,
        availableDistributableProfitMinor: 50_000n,
        operatingProfitMinor: 50_000n,
        frozen: true,
      }),
    ).toBe("FROZEN");

    expect(
      financialState({
        settledBalanceMinor: 4_000n,
        minimumReserveMinor: 10_000n,
        availableDistributableProfitMinor: 50_000n,
        operatingProfitMinor: 50_000n,
        frozen: false,
      }),
    ).toBe("CRITICAL");
  });
});
