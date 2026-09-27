import { describe, expect, test } from "bun:test";
import type { AgentLedgerEntry } from "../src/economy/model";
import {
  completeOwnerPayout,
  ownerPayoutLedgerEntry,
  planManualOwnerPayout,
} from "../src/economy/payout";
import type { EconomyExecutionPolicy } from "../src/economy/intents";

const policy: EconomyExecutionPolicy = {
  ownerShareBps: 5000n,
  reinvestmentShareBps: 3000n,
  reserveShareBps: 2000n,
  minimumReserveMinor: 10_000n,
  maxPaymentPerTransactionMinor: 50_000n,
  maxHourlySpendMinor: 60_000n,
  maxDailySpendMinor: 200_000n,
  maxMonthlySpendMinor: 1_000_000n,
  ownerConfirmationThresholdMinor: 10_000n,
  allowedPaymentAddresses: ["owner-wallet"],
  allowedPaymentCategories: ["owner_payout"],
  maxChildFundingMinor: 20_000n,
  maxX402PaymentMinor: 5_000n,
  allowedX402Domains: [],
  frozen: false,
};

function entry(
  id: string,
  type: AgentLedgerEntry["type"],
  direction: AgentLedgerEntry["direction"],
  amountMinor: bigint,
): AgentLedgerEntry {
  return {
    id,
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: id,
    type,
    direction,
    status: "settled",
    amountMinor,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  };
}

function plan(amountMinor: bigint, overrides: {
  settledBalanceMinor?: bigint;
  destination?: string;
  ledger?: AgentLedgerEntry[];
  policy?: EconomyExecutionPolicy;
} = {}) {
  return planManualOwnerPayout({
    agentId: "agent-a",
    accountId: "account-a",
    policyVersion: 4,
    amountMinor,
    destination: overrides.destination ?? "owner-wallet",
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    settledBalanceMinor: overrides.settledBalanceMinor ?? 100_000n,
    policy: overrides.policy ?? policy,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
    ledger:
      overrides.ledger ??
      [
        entry("revenue", "revenue", "credit", 100_000n),
        entry("cost", "operating_cost", "debit", 20_000n),
        entry("reserve", "reserve_allocation", "debit", 16_000n),
        entry("reinvest", "reinvestment", "debit", 24_000n),
      ],
  });
}

describe("Agent Economy manual Owner payout planning", () => {
  test("proves distributable profit and reserve before creating a payout intent", () => {
    const result = plan(5_000n);

    expect(result.intent).toEqual({
      agentId: "agent-a",
      kind: "OWNER_PAYOUT",
      amountMinor: 5_000n,
      destination: "owner-wallet",
      category: "owner_payout",
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.proof).toMatchObject({
      policyVersion: 4,
      operatingProfitMinor: 80_000n,
      distributableProfitBeforePayoutMinor: 40_000n,
      priorOwnerPayoutMinor: 0n,
      availableDistributableProfitMinor: 40_000n,
      settledBalanceMinor: 100_000n,
      balanceAfterMinor: 95_000n,
      minimumReserveMinor: 10_000n,
    });
  });

  test("requires Owner confirmation above the configured threshold", () => {
    expect(plan(15_000n).decision).toBe("OWNER_CONFIRMATION");
  });

  test("refuses to pay more than distributable profit", () => {
    expect(() => plan(40_001n)).toThrow(
      "payout exceeds distributable profit",
    );
  });

  test("refuses a payout that would breach minimum reserve", () => {
    expect(() => plan(5_000n, { settledBalanceMinor: 14_000n })).toThrow(
      "payout would breach minimum reserve",
    );
  });

  test("refuses a destination outside the Owner whitelist", () => {
    expect(() => plan(1_000n, { destination: "attacker-wallet" })).toThrow(
      "payout destination is not whitelisted",
    );
  });

  test("prior Owner payouts reduce what remains distributable", () => {
    const ledger = [
      entry("revenue", "revenue", "credit", 100_000n),
      entry("cost", "operating_cost", "debit", 20_000n),
      entry("reserve", "reserve_allocation", "debit", 16_000n),
      entry("reinvest", "reinvestment", "debit", 24_000n),
      entry("paid", "owner_payout", "debit", 35_000n),
    ];

    expect(plan(5_000n, { ledger }).proof.availableDistributableProfitMinor).toBe(
      5_000n,
    );
    expect(() => plan(5_001n, { ledger })).toThrow(
      "payout exceeds distributable profit",
    );
  });

  test("marks a payout complete only from a matching verified receipt", () => {
    const planned = plan(5_000n);
    const paidAt = new Date("2026-09-27T12:00:00Z");
    const completed = completeOwnerPayout({
      plan: planned,
      receipt: {
        intentId: "intent-1",
        agentId: "agent-a",
        accountId: "account-a",
        provider: "mock",
        externalReference: "transfer-1",
        providerStatus: "verified",
        assetCode: "USDC",
        amountMinor: 5_000n,
        destination: "owner-wallet",
        balanceBeforeMinor: 100_000n,
        balanceAfterMinor: 95_000n,
        verifiedAt: paidAt,
      },
    });

    expect(completed).toMatchObject({
      intentId: "intent-1",
      externalReference: "transfer-1",
      amountMinor: 5_000n,
      policyVersion: 4,
      paidAt,
    });
    expect(ownerPayoutLedgerEntry(completed)).toMatchObject({
      idempotencyKey: "owner-payout:transfer-1",
      type: "owner_payout",
      direction: "debit",
      status: "settled",
      amountMinor: 5_000n,
    });
  });

  test("refuses a verified receipt that differs from the payout proof", () => {
    const planned = plan(5_000n);
    expect(() =>
      completeOwnerPayout({
        plan: planned,
        receipt: {
          intentId: "intent-1",
          agentId: "agent-a",
          accountId: "account-a",
          provider: "mock",
          externalReference: "transfer-1",
          providerStatus: "verified",
          assetCode: "USDC",
          amountMinor: 4_999n,
          destination: "owner-wallet",
          balanceBeforeMinor: 100_000n,
          balanceAfterMinor: 95_001n,
          verifiedAt: new Date(),
        },
      }),
    ).toThrow("owner payout receipt amount does not match the plan");
  });

  test("kill switch still fails closed at payout planning", () => {
    expect(() =>
      plan(1_000n, { policy: { ...policy, frozen: true } }),
    ).toThrow("financial activity is frozen");
  });
});
