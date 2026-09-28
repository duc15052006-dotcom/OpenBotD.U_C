import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  createPaymentAccountingStore,
  PaymentAccountingRefusedError,
} from "../src/economy/payment-accounting-store";

function fakeDatabase(overrides: Record<string, unknown> = {}) {
  const proof = {
    intentId: "intent-1",
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "pay-1",
    kind: "OPERATING_EXPENSE",
    amountMinor: "1250",
    destination: "vendor-wallet",
    category: "api",
    decision: "ALLOW",
    policyVersion: 7,
    receiptAgentId: "agent-a",
    receiptAccountId: "account-a",
    receiptProviderStatus: "verified",
    receiptExternalReference: "tx-1",
    receiptAmountMinor: "1250",
    receiptAssetCode: "USDC",
    receiptDestination: "vendor-wallet",
    receiptVerifiedAt: new Date("2026-09-28T00:00:00.000Z"),
    accountAgentId: "agent-a",
    accountAssetCode: "USDC",
    accountAssetClass: "STABLECOIN",
    accountRedeemable: true,
    ...overrides,
  };
  let inserted: Record<string, unknown> | null = null;

  const transaction = {
    select(shape: Record<string, unknown>) {
      const isProof = "intentId" in shape;
      return {
        from() {
          const chain = {
            innerJoin() {
              return chain;
            },
            where() {
              return {
                async limit() {
                  if (isProof) return [proof];
                  if (!inserted) return [];
                  return [
                    {
                      id: "ledger-1",
                      agentId: inserted.agentId,
                      accountId: inserted.accountId,
                      idempotencyKey: inserted.idempotencyKey,
                      type: inserted.type,
                      direction: inserted.direction,
                      status: inserted.status,
                      amountMinor: inserted.amountMinor,
                      assetCode: inserted.assetCode,
                      assetClass: inserted.assetClass,
                      redeemable: inserted.redeemable,
                      costCategory: inserted.costCategory,
                      destination: inserted.destination,
                      approval: inserted.approval,
                      policyVersion: inserted.policyVersion,
                      externalReference: inserted.externalReference,
                      occurredAt: inserted.occurredAt,
                    },
                  ];
                },
              };
            },
          };
          return chain;
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          inserted = values;
          return {
            async onConflictDoNothing() {},
          };
        },
      };
    },
  };

  const database = {
    transaction: async <T>(use: (tx: typeof transaction) => Promise<T>) =>
      use(transaction),
  } as unknown as Database;

  return { database, getInserted: () => inserted };
}

describe("Agent Economy payment accounting store", () => {
  test("persists a verified operating payment as a settled debit ledger entry", async () => {
    const fake = fakeDatabase();
    const store = createPaymentAccountingStore(fake.database);

    const entry = await store.persistOperatingPayment("intent-1");

    expect(entry).toEqual({
      id: "ledger-1",
      agentId: "agent-a",
      accountId: "account-a",
      idempotencyKey: "ledger:payment:pay-1",
      type: "operating_cost",
      direction: "debit",
      status: "settled",
      amountMinor: 1250n,
      assetCode: "USDC",
      assetClass: "STABLECOIN",
      redeemable: true,
      occurredAt: new Date("2026-09-28T00:00:00.000Z"),
    });
    expect(fake.getInserted()).toMatchObject({
      idempotencyKey: "ledger:payment:pay-1",
      type: "operating_cost",
      direction: "debit",
      status: "settled",
      costCategory: "api",
      source: "payment_intent",
      purpose: "operating_expense",
      approval: "ALLOW",
      externalReference: "tx-1",
      metadata: { intentId: "intent-1", kind: "OPERATING_EXPENSE" },
    });
  });

  test("accounts x402 as an operating debit with x402 purpose", async () => {
    const fake = fakeDatabase({
      kind: "X402_PAYMENT",
      category: "x402",
    });
    const store = createPaymentAccountingStore(fake.database);

    await store.persistOperatingPayment("intent-1");

    expect(fake.getInserted()).toMatchObject({
      type: "operating_cost",
      costCategory: "x402",
      purpose: "x402_payment",
      metadata: { intentId: "intent-1", kind: "X402_PAYMENT" },
    });
  });

  test("refuses receipt amount mismatch before inserting ledger history", async () => {
    const fake = fakeDatabase({ receiptAmountMinor: "1249" });
    const store = createPaymentAccountingStore(fake.database);

    await expect(
      store.persistOperatingPayment("intent-1"),
    ).rejects.toBeInstanceOf(PaymentAccountingRefusedError);
    expect(fake.getInserted()).toBeNull();
  });

  test("refuses denied or non-operating durable intents", async () => {
    const denied = createPaymentAccountingStore(
      fakeDatabase({ decision: "DENY" }).database,
    );
    await expect(
      denied.persistOperatingPayment("intent-1"),
    ).rejects.toBeInstanceOf(PaymentAccountingRefusedError);

    const payout = createPaymentAccountingStore(
      fakeDatabase({ kind: "OWNER_PAYOUT" }).database,
    );
    await expect(
      payout.persistOperatingPayment("intent-1"),
    ).rejects.toBeInstanceOf(PaymentAccountingRefusedError);
  });
});
