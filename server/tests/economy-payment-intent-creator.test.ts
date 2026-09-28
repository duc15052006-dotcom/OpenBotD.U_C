import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  createPaymentIntentCreator,
  PaymentIntentCreationConflictError,
  type CreatedPaymentIntent,
  type PaymentIntentCreationSnapshot,
} from "../src/economy/payment-intent-creator";
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
  allowedPaymentAddresses: ["vendor-wallet"],
  allowedPaymentCategories: ["api"],
  maxChildFundingMinor: 20_000n,
  maxX402PaymentMinor: 5_000n,
  allowedX402Domains: [],
  frozen: false,
};

function fakeDatabase() {
  let stored: Record<string, unknown> | null = null;
  let inserted: Record<string, unknown> | null = null;

  const database = {
    select(shape: Record<string, unknown>) {
      const accountSelect = "profileAgentId" in shape;
      return {
        from() {
          return {
            leftJoin() {
              return {
                where() {
                  return {
                    async limit() {
                      return accountSelect
                        ? [
                            {
                              id: "account-a",
                              agentId: "agent-a",
                              assetCode: "USDC",
                              provider: "mock-provider",
                              profileAgentId: "agent-a",
                            },
                          ]
                        : [];
                    },
                  };
                },
              };
            },
            innerJoin() {
              return {
                where() {
                  return {
                    async limit() {
                      return stored ? [stored] : [];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          inserted = values;
          return {
            async onConflictDoNothing() {
              if (!stored) {
                stored = {
                  id: "intent-id",
                  ...values,
                  requestedAt: new Date("2026-09-28T10:00:00.000Z"),
                  assetCode: "USDC",
                  provider: "mock-provider",
                };
              }
            },
          };
        },
      };
    },
  } as unknown as Database;

  return {
    database,
    getInserted: () => inserted,
    setStored: (value: CreatedPaymentIntent) => {
      stored = {
        ...value,
        amountMinor: value.amountMinor.toString(),
        x402Domain: value.x402Domain ?? null,
      };
    },
  };
}

function snapshot(
  overrides: Partial<PaymentIntentCreationSnapshot> = {},
): PaymentIntentCreationSnapshot {
  return {
    version: 7,
    policy,
    settledBalanceMinor: 100_000n,
    availableDistributableProfitMinor: 20_000n,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
    ...overrides,
  };
}

function input() {
  return {
    accountId: "account-a",
    idempotencyKey: "pay-1",
    intent: {
      agentId: "agent-a",
      kind: "OPERATING_EXPENSE" as const,
      amountMinor: 1_000n,
      destination: "vendor-wallet",
      category: "api",
    },
    initiator: { kind: "person" as const, id: "owner-a" },
  };
}

describe("Agent Economy payment intent creator", () => {
  test("derives and persists the server-side policy decision", async () => {
    const fake = fakeDatabase();
    const creator = createPaymentIntentCreator(fake.database, async () =>
      snapshot(),
    );

    const created = await creator.create(input());

    expect(created).toMatchObject({
      id: "intent-id",
      decision: "ALLOW",
      decisionReason: "financial policy allows payment",
      policyVersion: 7,
      assetCode: "USDC",
      provider: "mock-provider",
      initiatorKind: "person",
      initiatorId: "owner-a",
    });
    expect(fake.getInserted()).toMatchObject({
      decision: "ALLOW",
      decisionReason: "financial policy allows payment",
      policyVersion: 7,
      initiatorKind: "person",
      initiatorId: "owner-a",
    });
  });

  test("derives DENY from the server-owned snapshot", async () => {
    const fake = fakeDatabase();
    const creator = createPaymentIntentCreator(fake.database, async () =>
      snapshot({
        version: 9,
        policy: { ...policy, frozen: true },
      }),
    );

    const created = await creator.create(input());

    expect(created).toMatchObject({
      decision: "DENY",
      decisionReason: "financial activity is frozen",
      policyVersion: 9,
    });
  });

  test("replays the same request without re-evaluating a changed policy", async () => {
    const fake = fakeDatabase();
    let snapshotLoads = 0;
    const creator = createPaymentIntentCreator(fake.database, async () => {
      snapshotLoads += 1;
      return snapshotLoads === 1
        ? snapshot()
        : snapshot({
            version: 8,
            policy: { ...policy, frozen: true },
          });
    });

    const first = await creator.create(input());
    const second = await creator.create(input());

    expect(second).toEqual(first);
    expect(first.decision).toBe("ALLOW");
    expect(first.policyVersion).toBe(7);
    expect(snapshotLoads).toBe(1);
  });

  test("rejects an idempotency key reused for another durable request", async () => {
    const fake = fakeDatabase();
    const creator = createPaymentIntentCreator(fake.database, async () =>
      snapshot(),
    );

    await creator.create(input());

    await expect(
      creator.create({
        ...input(),
        intent: {
          ...input().intent,
          destination: "another-wallet",
        },
      }),
    ).rejects.toBeInstanceOf(PaymentIntentCreationConflictError);
  });

  test("rejects an idempotency key reused by another initiator", async () => {
    const fake = fakeDatabase();
    const creator = createPaymentIntentCreator(fake.database, async () =>
      snapshot(),
    );

    await creator.create(input());

    await expect(
      creator.create({
        ...input(),
        initiator: { kind: "person", id: "other-owner" },
      }),
    ).rejects.toBeInstanceOf(PaymentIntentCreationConflictError);
  });
});
