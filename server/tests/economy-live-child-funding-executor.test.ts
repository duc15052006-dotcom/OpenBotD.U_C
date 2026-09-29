import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import type {
  ChildFundingReservation,
  ChildFundingReservationStore,
} from "../src/economy/child-funding-reservation-store";
import type {
  ChildFundingStore,
  PersistedChildFunding,
} from "../src/economy/child-funding-store";
import type {
  VerifiedPaymentReceipt,
  VerifiedPaymentReceiptStore,
} from "../src/economy/execution";
import {
  createLiveChildFundingExecutor,
} from "../src/economy/live-child-funding-executor";
import type { OwnerPaymentApprovalStore } from "../src/economy/approval-store";
import type { PaymentAdapterResolver } from "../src/economy/payment-adapter-resolver";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "../src/economy/payment-intent-store";

const auditStore: AuditStore = {
  insert: async () => {},
};

function durable(
  overrides: Partial<DurablePaymentIntent> = {},
): DurablePaymentIntent {
  return {
    id: "intent-child-1",
    agentId: "parent-a",
    accountId: "parent-account",
    idempotencyKey: "child-pay-1",
    kind: "CHILD_FUNDING",
    amountMinor: 5_000n,
    assetCode: "USDC",
    provider: "mock-provider",
    destination: "child-wallet",
    category: "child_funding",
    decision: "ALLOW",
    policyVersion: 7,
    ...overrides,
  };
}

function reader(value: DurablePaymentIntent = durable()): PaymentIntentReader {
  return {
    load: async (id) => (id === value.id ? value : null),
  };
}

function receipts(): VerifiedPaymentReceiptStore {
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

function reservation(): ChildFundingReservation {
  return {
    id: "reservation-1",
    relationshipId: "relationship-1",
    intentId: "intent-child-1",
    parentAgentId: "parent-a",
    parentAccountId: "parent-account",
    childAgentId: "child-a",
    childAccountId: "child-account",
    amountMinor: 5_000n,
    assetCode: "USDC",
    policyVersion: 7,
    reservedUntil: new Date("2026-09-29T00:15:00.000Z"),
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
  };
}

function reservationStore(input?: {
  onReserve?: () => void | Promise<void>;
  onAssert?: () => void | Promise<void>;
}): ChildFundingReservationStore {
  return {
    reserve: async () => {
      await input?.onReserve?.();
      return reservation();
    },
    assertExecutable: async () => {
      await input?.onAssert?.();
    },
  };
}

function persistedFunding(): PersistedChildFunding {
  return {
    event: {
      id: "funding-event-1",
      relationshipId: "relationship-1",
      intentId: "intent-child-1",
      receiptId: "receipt-1",
      parentAgentId: "parent-a",
      childAgentId: "child-a",
      amountMinor: 5_000n,
      assetCode: "USDC",
      policyVersion: 7,
      fundedAt: new Date("2026-09-29T00:01:00.000Z"),
    },
    parentLedgerEntry: {
      id: "parent-ledger-1",
      agentId: "parent-a",
      accountId: "parent-account",
      idempotencyKey: "ledger:child-funding:parent:child-pay-1",
      type: "adjustment",
      direction: "debit",
      status: "settled",
      amountMinor: 5_000n,
      assetCode: "USDC",
      assetClass: "STABLECOIN",
      redeemable: true,
      occurredAt: new Date("2026-09-29T00:01:00.000Z"),
    },
    childLedgerEntry: {
      id: "child-ledger-1",
      agentId: "child-a",
      accountId: "child-account",
      idempotencyKey: "ledger:child-funding:child:child-pay-1",
      type: "investment",
      direction: "credit",
      status: "settled",
      amountMinor: 5_000n,
      assetCode: "USDC",
      assetClass: "STABLECOIN",
      redeemable: true,
      occurredAt: new Date("2026-09-29T00:01:00.000Z"),
    },
  };
}

function fundingStore(
  onPersist?: () => void | Promise<void>,
): ChildFundingStore {
  return {
    persistVerified: async () => {
      await onPersist?.();
      return persistedFunding();
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
      allowedPaymentAddresses: ["child-wallet"],
      allowedPaymentCategories: ["child_funding"],
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

describe("Agent Economy live child funding executor", () => {
  test("recovers funding accounting after a verified transfer without paying twice", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    const receiptStore = receipts();
    let fundingAttempts = 0;
    let reservationChecks = 0;

    const executor = createLiveChildFundingExecutor({
      intentReader: reader(),
      reservationStore: reservationStore({
        onAssert: () => {
          reservationChecks += 1;
        },
      }),
      fundingStore: fundingStore(() => {
        fundingAttempts += 1;
        if (fundingAttempts === 1) {
          throw new Error("funding accounting unavailable");
        }
      }),
      adapterResolver: resolver(adapter),
      receiptStore,
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-child-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow("funding accounting unavailable");

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);
    expect(reservationChecks).toBe(1);

    const recovered = await executor.execute({
      intentId: "intent-child-1",
      actorUserId: "owner-a",
    });

    expect(recovered.receipt.externalReference).toBe("mock:child-pay-1");
    expect(recovered.ledgerEntry.id).toBe("parent-ledger-1");
    expect(recovered.childLedgerEntry.id).toBe("child-ledger-1");
    expect(fundingAttempts).toBe(2);
    expect(reservationChecks).toBe(1);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);
  });

  test("reserves budget before the payment adapter is resolved", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    let resolverUses = 0;

    const executor = createLiveChildFundingExecutor({
      intentReader: reader(),
      reservationStore: {
        reserve: async () => {
          throw new Error("budget unavailable");
        },
        assertExecutable: async () => {},
      },
      fundingStore: fundingStore(),
      adapterResolver: resolver(adapter, () => {
        resolverUses += 1;
      }),
      receiptStore: receipts(),
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-child-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow("budget unavailable");

    expect(resolverUses).toBe(0);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(50_000n);
  });

  test("fails before provider execution when the reserved relationship changes", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });

    const executor = createLiveChildFundingExecutor({
      intentReader: reader(),
      reservationStore: reservationStore({
        onAssert: () => {
          throw new Error("relationship changed after reservation");
        },
      }),
      fundingStore: fundingStore(),
      adapterResolver: resolver(adapter),
      receiptStore: receipts(),
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-child-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow("relationship changed after reservation");

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(50_000n);
  });
});
