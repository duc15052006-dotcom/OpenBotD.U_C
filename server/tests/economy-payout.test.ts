import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import {
  executeManualOwnerPayout,
  type ManualOwnerPayoutResult,
} from "../src/economy/payout";
import {
  PaymentExecutionRefusedError,
  type PaymentPolicySnapshot,
  type VerifiedPaymentReceipt,
  type VerifiedPaymentReceiptStore,
} from "../src/economy/execution";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";
import type { AgentLedgerEntry } from "../src/economy/model";
import type { EconomyExecutionPolicy } from "../src/economy/intents";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "../src/economy/payment-intent-store";
import type {
  OwnerPayoutAccountingStore,
  PersistOwnerPayoutAccountingInput,
} from "../src/economy/payout-store";

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

function memoryReceiptStore(): VerifiedPaymentReceiptStore {
  let stored: VerifiedPaymentReceipt | null = null;
  return {
    loadByIntent: async (intentId) =>
      stored?.intentId === intentId ? stored : null,
    saveVerified: async (receipt) => {
      if (stored && stored.intentId === receipt.intentId) {
        return { receipt: stored, created: false };
      }
      stored = receipt;
      return { receipt, created: true };
    },
  };
}

const auditStore: AuditStore = {
  insert: async () => {},
};

function payoutIntentReader(
  overrides: Partial<DurablePaymentIntent> = {},
): PaymentIntentReader {
  return {
    load: async (intentId) =>
      intentId === "intent-1"
        ? {
            id: "intent-1",
            agentId: "agent-a",
            accountId: "account-a",
            idempotencyKey: "payout-1",
            kind: "OWNER_PAYOUT",
            amountMinor: 5_000n,
            assetCode: "USDC",
            provider: "mock",
            destination: "owner-wallet",
            category: "owner_payout",
            decision: "ALLOW",
            policyVersion: 1,
            ...overrides,
          }
        : null,
  };
}

function memoryPayoutStore(
  onPersist?: (
    input: PersistOwnerPayoutAccountingInput,
  ) => void | Promise<void>,
): OwnerPayoutAccountingStore {
  let stored:
    | {
        input: PersistOwnerPayoutAccountingInput;
        payoutId: string;
        ledgerEntry: AgentLedgerEntry;
      }
    | undefined;

  return {
    persist: async (input) => {
      await onPersist?.(input);
      if (stored) {
        return {
          payoutId: stored.payoutId,
          ledgerEntry: stored.ledgerEntry,
        };
      }
      const ledgerEntry: AgentLedgerEntry = {
        id: `owner-payout:${input.externalReference}`,
        agentId: input.agentId,
        accountId: input.accountId,
        idempotencyKey: `ledger:${input.payoutIdempotencyKey}`,
        type: "owner_payout",
        direction: "debit",
        status: "settled",
        amountMinor: input.amountMinor,
        assetCode: input.assetCode,
        assetClass: input.assetClass,
        redeemable: true,
        occurredAt: input.paidAt,
      };
      stored = { input, payoutId: "payout-record-1", ledgerEntry };
      return { payoutId: stored.payoutId, ledgerEntry };
    },
  };
}

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
    receiptStore: memoryReceiptStore(),
    intentReader: payoutIntentReader(),
    payoutStore: memoryPayoutStore(),
    requestedBy: "owner-a",
    audit: { store: auditStore },
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

  test("recovers payout accounting after a post-transfer persistence failure without paying twice", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    const receiptStore = memoryReceiptStore();
    let persistAttempts = 0;
    const payoutStore = memoryPayoutStore(() => {
      persistAttempts += 1;
      if (persistAttempts === 1) {
        throw new Error("database temporarily unavailable");
      }
    });

    await expect(
      payout({
        adapter,
        receiptStore,
        payoutStore,
      }),
    ).rejects.toThrow("database temporarily unavailable");

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);

    const recovered = await payout({
      adapter,
      receiptStore,
      payoutStore,
    });

    expect(recovered.receipt.amountMinor).toBe(5_000n);
    expect(recovered.ledgerEntry.idempotencyKey).toBe("ledger:payout-1");
    expect(persistAttempts).toBe(2);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);
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
        intentReader: payoutIntentReader({ amountMinor: 15_000n }),
        loadPolicySnapshot: async () =>
          snapshot({ settledBalanceMinor: 20_000n }),
      }),
    ).rejects.toThrow("payment would breach minimum reserve");
  });

  test("large payout still requires explicit Owner confirmation", async () => {
    await expect(
      payout({
        amountMinor: 15_000n,
        intentReader: payoutIntentReader({ amountMinor: 15_000n }),
      }),
    ).rejects.toThrow(
      "Owner confirmation is required before payment execution",
    );

    const confirmed = await payout({
      amountMinor: 15_000n,
      intentReader: payoutIntentReader({
        amountMinor: 15_000n,
        decision: "OWNER_CONFIRMATION",
      }),
      authorization: {
        decision: "OWNER_CONFIRMATION",
        policyVersion: 1,
        approvalId: "approval-1",
      },
      loadOwnerApproval: async () => ({
        id: "approval-1",
        intentId: "intent-1",
        agentId: "agent-a",
        policyVersion: 1,
        approverKind: "OWNER",
        approverId: "owner-a",
        approvedAt: new Date("2026-09-27T00:30:00Z"),
      }),
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
