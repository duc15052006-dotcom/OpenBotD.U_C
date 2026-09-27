import { describe, expect, test } from "bun:test";
import {
  executeManualOwnerPayout,
  type ManualOwnerPayoutResult,
} from "../src/economy/payout";
import {
  PaymentExecutionRefusedError,
  type PaymentPolicySnapshot,
} from "../src/economy/execution";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";
import type { AgentLedgerEntry } from "../src/economy/model";
import type { EconomyExecutionPolicy } from "../src/economy/intents";

const policy: EconomyExecutionPolicy = {
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
  maxChildFundingMinor: 20_000n,
  maxX402PaymentMinor: 5_000n,
  allowedX402Domains: [],
  frozen: false,
};

function ledgerEntry(
  id: string,
  type: AgentLedgerEntry["type"],
  direction: AgentLedgerEntry["direction"],
  amountMinor: bigint,
): AgentLedgerEntry {
  return {
    id,
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: `ledger-${id}`,
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

const ledger: AgentLedgerEntry[] = [
  ledgerEntry("revenue", "revenue", "credit", 50_000n),
  ledgerEntry("cost", "operating_cost", "debit", 10_000n),
  ledgerEntry("reserve", "reserve_allocation", "debit", 8_000n),
  ledgerEntry("reinvest", "reinvestment", "debit", 12_000n),
];

function snapshot(
  overrides: Partial<PaymentPolicySnapshot> = {},
): PaymentPolicySnapshot {
  return {
    version: 1,
    policy,
    settledBalanceMinor: 50_000n,
    availableDistributableProfitMinor: 20_000n,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
    ...overrides,
  };
}

async function payout(
  overrides: Partial<Parameters<typeof executeManualOwnerPayout>[0]> = {},
): Promise<ManualOwnerPayoutResult> {
  return executeManualOwnerPayout({
    intentId: "intent-1",
    idempotencyKey: "payout-1",
    agentId: "agent-a",
    accountId: "account-a",
    assetCode: "USDC",
    amountMinor: 5_000n,
    destination: "owner-wallet",
    provider: "mock",
    authorization: { decision: "ALLOW", policyVersion: 1 },
    ledgerEntries: ledger,
    adapter: new InMemoryPaymentAccountAdapter({ USDC: 50_000n }),
    loadPolicySnapshot: async () => snapshot(),
    occurredAt: new Date("2026-09-27T01:00:00Z"),
    ...overrides,
  });
}

describe("Agent Economy manual Owner payout", () => {
  test("executes only against ledger-proven distributable profit", async () => {
    const result = await payout();

    expect(result.pnlBeforePayout.availableDistributableProfitMinor).toBe(
      20_000n,
    );
    expect(result.receipt.amountMinor).toBe(5_000n);
    expect(result.ledgerEntry).toEqual({
      id: "owner-payout:mock:payout-1",
      agentId: "agent-a",
      accountId: "account-a",
      idempotencyKey: "ledger:payout-1",
      type: "owner_payout",
      direction: "debit",
      status: "settled",
      amountMinor: 5_000n,
      assetCode: "USDC",
      assetClass: "STABLECOIN",
      redeemable: true,
      occurredAt: new Date("2026-09-27T01:00:00Z"),
    });
  });

  test("refuses a payout larger than ledger-proven profit even if snapshot claims more", async () => {
    await expect(
      payout({
        amountMinor: 20_001n,
        loadPolicySnapshot: async () =>
          snapshot({ availableDistributableProfitMinor: 999_999n }),
      }),
    ).rejects.toThrow(
      "Owner payout exceeds ledger-proven distributable profit",
    );
  });

  test("cannot bypass reserve by having enough distributable profit", async () => {
    await expect(
      payout({
        amountMinor: 15_000n,
        loadPolicySnapshot: async () =>
          snapshot({ settledBalanceMinor: 20_000n }),
      }),
    ).rejects.toThrow("payment would breach minimum reserve");
  });

  test("large payout still requires explicit Owner confirmation", async () => {
    await expect(
      payout({ amountMinor: 15_000n }),
    ).rejects.toThrow(
      "Owner confirmation is required before payment execution",
    );

    const confirmed = await payout({
      amountMinor: 15_000n,
      authorization: {
        decision: "OWNER_CONFIRMATION",
        policyVersion: 1,
        ownerConfirmed: true,
      },
    });
    expect(confirmed.receipt.amountMinor).toBe(15_000n);
  });

  test("financial freeze landing after prepare stops execution", async () => {
    let reads = 0;
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });

    await expect(
      payout({
        adapter,
        loadPolicySnapshot: async () => {
          reads += 1;
          return snapshot({
            policy: reads === 1 ? policy : { ...policy, frozen: true },
          });
        },
      }),
    ).rejects.toBeInstanceOf(PaymentExecutionRefusedError);

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(50_000n);
  });
});
