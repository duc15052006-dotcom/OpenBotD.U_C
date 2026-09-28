import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import type { OwnerPaymentApprovalStore } from "../src/economy/approval-store";
import type { PaymentAccountingStore } from "../src/economy/payment-accounting-store";
import type { PaymentAdapterResolver } from "../src/economy/payment-adapter-resolver";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "../src/economy/payment-intent-store";
import {
  createLiveOperatingPaymentExecutor,
  LiveOperatingPaymentUnsupportedError,
} from "../src/economy/live-payment-executor";
import type {
  VerifiedPaymentReceipt,
  VerifiedPaymentReceiptStore,
} from "../src/economy/execution";

const auditStore: AuditStore = {
  insert: async () => {},
};

function durable(
  overrides: Partial<DurablePaymentIntent> = {},
): DurablePaymentIntent {
  return {
    id: "intent-1",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "pay-1",
    kind: "OPERATING_EXPENSE",
    amountMinor: 5_000n,
    assetCode: "USDC",
    provider: "mock-provider",
    destination: "vendor-wallet",
    category: "api",
    decision: "ALLOW",
    policyVersion: 7,
    ...overrides,
  };
}

function intentReader(
  value: DurablePaymentIntent = durable(),
): PaymentIntentReader {
  return {
    load: async (id) => (id === value.id ? value : null),
  };
}

function receiptStore(): VerifiedPaymentReceiptStore {
  let stored: VerifiedPaymentReceipt | null = null;
  return {
    loadByIntent: async (intentId) =>
      stored?.intentId === intentId ? stored : null,
    saveVerified: async (receipt) => {
      if (!stored) {
        stored = receipt;
        return { receipt, created: true };
      }
      return { receipt: stored, created: false };
    },
  };
}

function approvals(): OwnerPaymentApprovalStore {
  return {
    approve: async () => {
      throw new Error("not used");
    },
    load: async () => null,
  };
}

function resolver(
  adapter: InMemoryPaymentAccountAdapter,
  onUse?: () => void,
): PaymentAdapterResolver {
  return {
    useForAccount: async ({ use }) => {
      onUse?.();
      return use(adapter, "mock-provider");
    },
  };
}

function accountingStore(
  onPersist?: () => void | Promise<void>,
): PaymentAccountingStore {
  return {
    persistOperatingPayment: async () => {
      await onPersist?.();
      return {
        id: "ledger-1",
        agentId: "agent-a",
        accountId: "account-a",
        idempotencyKey: "ledger:payment:pay-1",
        type: "operating_cost",
        direction: "debit",
        status: "settled",
        amountMinor: 5_000n,
        assetCode: "USDC",
        assetClass: "STABLECOIN",
        redeemable: true,
        occurredAt: new Date("2026-09-28T00:00:00.000Z"),
      };
    },
  };
}

function snapshot() {
  return {
    version: 7,
    policy: {
      ownerShareBps: 5000n,
      reinvestmentShareBps: 3000n,
      reserveShareBps: 2000n,
      minimumReserveMinor: 10_000n,
      maxPaymentPerTransactionMinor: 50_000n,
      maxHourlySpendMinor: 60_000n,
      maxDailySpendMinor: 200_000n,
      maxMonthlySpendMinor: 1_000_000n,
      ownerConfirmationThresholdMinor: 10_000n,
      allowedPaymentAddresses: ["vendor-wallet"],
      allowedPaymentCategories: ["api"],
      maxChildFundingMinor: 20_000n,
      maxX402PaymentMinor: 5_000n,
      allowedX402Domains: [],
      frozen: false,
    },
    settledBalanceMinor: 50_000n,
    availableDistributableProfitMinor: 20_000n,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
  };
}

describe("Agent Economy live operating payment executor", () => {
  test("recovers accounting after a verified transfer without paying twice", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    const receipts = receiptStore();
    let accountingAttempts = 0;
    const executor = createLiveOperatingPaymentExecutor({
      intentReader: intentReader(),
      adapterResolver: resolver(adapter),
      receiptStore: receipts,
      accountingStore: accountingStore(() => {
        accountingAttempts += 1;
        if (accountingAttempts === 1) {
          throw new Error("accounting unavailable");
        }
      }),
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow("accounting unavailable");

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);

    const recovered = await executor.execute({
      intentId: "intent-1",
      actorUserId: "owner-a",
    });

    expect(recovered.receipt.externalReference).toBe("mock:pay-1");
    expect(recovered.ledgerEntry.id).toBe("ledger-1");
    expect(accountingAttempts).toBe(2);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);
  });

  test("blocks specialized payout and child-funding kinds before adapter use", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    let resolverUses = 0;

    for (const kind of ["OWNER_PAYOUT", "CHILD_FUNDING"] as const) {
      const executor = createLiveOperatingPaymentExecutor({
        intentReader: intentReader(durable({ kind })),
        adapterResolver: resolver(adapter, () => {
          resolverUses += 1;
        }),
        receiptStore: receiptStore(),
        accountingStore: accountingStore(),
        approvalStore: approvals(),
        loadPolicySnapshot: async () => snapshot(),
        auditStore,
      });

      await expect(
        executor.execute({
          intentId: "intent-1",
          actorUserId: "owner-a",
        }),
      ).rejects.toBeInstanceOf(LiveOperatingPaymentUnsupportedError);
    }

    expect(resolverUses).toBe(0);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(50_000n);
  });

  test("requires persisted Owner approval before resolver use", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    let resolverUses = 0;
    const executor = createLiveOperatingPaymentExecutor({
      intentReader: intentReader(
        durable({
          decision: "OWNER_CONFIRMATION",
          amountMinor: 15_000n,
        }),
      ),
      adapterResolver: resolver(adapter, () => {
        resolverUses += 1;
      }),
      receiptStore: receiptStore(),
      accountingStore: accountingStore(),
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow(
      "persisted Owner approval is required before payment execution",
    );
    expect(resolverUses).toBe(0);
  });
});
