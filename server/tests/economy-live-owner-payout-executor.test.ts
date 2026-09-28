import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import type { OwnerPaymentApprovalStore } from "../src/economy/approval-store";
import type { AgentLedgerReader } from "../src/economy/ledger-reader";
import { createLiveOwnerPayoutExecutor } from "../src/economy/live-owner-payout-executor";
import type { AgentLedgerEntry } from "../src/economy/model";
import type { PaymentAdapterResolver } from "../src/economy/payment-adapter-resolver";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "../src/economy/payment-intent-store";
import type {
  OwnerPayoutAccountingStore,
  PersistOwnerPayoutAccountingInput,
} from "../src/economy/payout-store";
import type {
  VerifiedPaymentReceipt,
  VerifiedPaymentReceiptStore,
} from "../src/economy/execution";

const auditStore: AuditStore = { insert: async () => {} };

function durable(
  overrides: Partial<DurablePaymentIntent> = {},
): DurablePaymentIntent {
  return {
    id: "intent-1",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "payout-1",
    kind: "OWNER_PAYOUT",
    amountMinor: 5_000n,
    assetCode: "USDC",
    provider: "mock-provider",
    destination: "owner-wallet",
    category: "owner_payout",
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

const ledger: AgentLedgerEntry[] = [
  {
    id: "revenue",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "ledger-revenue",
    type: "revenue",
    direction: "credit",
    status: "settled",
    amountMinor: 50_000n,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  },
  {
    id: "cost",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "ledger-cost",
    type: "operating_cost",
    direction: "debit",
    status: "settled",
    amountMinor: 10_000n,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  },
  {
    id: "reserve",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "ledger-reserve",
    type: "reserve_allocation",
    direction: "debit",
    status: "settled",
    amountMinor: 8_000n,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  },
  {
    id: "reinvest",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "ledger-reinvest",
    type: "reinvestment",
    direction: "debit",
    status: "settled",
    amountMinor: 12_000n,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  },
];

function ledgerReader(onLoad?: () => void): AgentLedgerReader {
  return {
    loadAgentAsset: async () => {
      onLoad?.();
      return ledger;
    },
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

function payoutStore(
  onPersist?: (
    input: PersistOwnerPayoutAccountingInput,
  ) => void | Promise<void>,
): OwnerPayoutAccountingStore {
  let stored: AgentLedgerEntry | null = null;
  return {
    persist: async (input) => {
      await onPersist?.(input);
      stored ??= {
        id: "payout-ledger-1",
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
      return { payoutId: "payout-1", ledgerEntry: stored };
    },
  };
}

function approvals(
  approval = null as Awaited<
    ReturnType<OwnerPaymentApprovalStore["load"]>
  >,
): OwnerPaymentApprovalStore {
  return {
    approve: async () => {
      throw new Error("not used");
    },
    load: async () => approval,
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

function snapshot() {
  return {
    version: 7,
    policy: {
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
    },
    settledBalanceMinor: 50_000n,
    availableDistributableProfitMinor: 20_000n,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
  };
}

describe("Agent Economy live Owner payout executor", () => {
  test("recovers accounting after transfer without paying twice", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    const receipts = receiptStore();
    let attempts = 0;
    const executor = createLiveOwnerPayoutExecutor({
      intentReader: intentReader(),
      ledgerReader: ledgerReader(),
      adapterResolver: resolver(adapter),
      receiptStore: receipts,
      payoutStore: payoutStore(() => {
        attempts += 1;
        if (attempts === 1) throw new Error("payout accounting unavailable");
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
    ).rejects.toThrow("payout accounting unavailable");

    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);

    const recovered = await executor.execute({
      intentId: "intent-1",
      actorUserId: "owner-a",
    });

    expect(recovered.receipt.externalReference).toBe("mock:payout-1");
    expect(recovered.ledgerEntry.id).toBe("payout-ledger-1");
    expect(attempts).toBe(2);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(45_000n);
  });

  test("requires persisted approval before ledger or adapter access", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    let ledgerLoads = 0;
    let resolverUses = 0;
    const executor = createLiveOwnerPayoutExecutor({
      intentReader: intentReader(
        durable({
          decision: "OWNER_CONFIRMATION",
          amountMinor: 15_000n,
        }),
      ),
      ledgerReader: ledgerReader(() => {
        ledgerLoads += 1;
      }),
      adapterResolver: resolver(adapter, () => {
        resolverUses += 1;
      }),
      receiptStore: receiptStore(),
      payoutStore: payoutStore(),
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
      "persisted Owner approval is required before payout execution",
    );

    expect(ledgerLoads).toBe(0);
    expect(resolverUses).toBe(0);
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(50_000n);
  });

  test("refuses non-payout intents before ledger or adapter access", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 50_000n });
    let ledgerLoads = 0;
    let resolverUses = 0;
    const executor = createLiveOwnerPayoutExecutor({
      intentReader: intentReader(durable({ kind: "CHILD_FUNDING" })),
      ledgerReader: ledgerReader(() => {
        ledgerLoads += 1;
      }),
      adapterResolver: resolver(adapter, () => {
        resolverUses += 1;
      }),
      receiptStore: receiptStore(),
      payoutStore: payoutStore(),
      approvalStore: approvals(),
      loadPolicySnapshot: async () => snapshot(),
      auditStore,
    });

    await expect(
      executor.execute({
        intentId: "intent-1",
        actorUserId: "owner-a",
      }),
    ).rejects.toThrow("payment intent is not an Owner payout");

    expect(ledgerLoads).toBe(0);
    expect(resolverUses).toBe(0);
  });
});
