import { describe, expect, test } from "bun:test";
import {
  dedupeRevenueEvents,
  revenueLedgerEntry,
  type NormalizedRevenueEvent,
} from "../src/economy/revenue";

function event(
  overrides: Partial<NormalizedRevenueEvent> = {},
): NormalizedRevenueEvent {
  return {
    adapterId: "saas",
    externalEventId: "invoice-1",
    agentId: "agent-a",
    accountId: "account-a",
    status: "settled",
    amountMinor: 25_000n,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    source: "subscription",
    occurredAt: new Date("2026-09-27T00:00:00Z"),
    settledAt: new Date("2026-09-27T00:01:00Z"),
    evidence: { invoiceId: "invoice-1" },
    ...overrides,
  };
}

describe("Agent Economy normalized revenue", () => {
  test("turns only settled redeemable revenue into ledger revenue", () => {
    expect(revenueLedgerEntry(event())).toMatchObject({
      idempotencyKey: "revenue:saas:invoice-1:settled",
      type: "revenue",
      direction: "credit",
      status: "settled",
      amountMinor: 25_000n,
    });

    expect(
      revenueLedgerEntry(event({ status: "pending", settledAt: undefined })),
    ).toBeNull();

    expect(
      revenueLedgerEntry(
        event({
          redeemable: false,
          assetClass: "COMPUTE_CREDIT",
          assetCode: "COMPUTE",
        }),
      ),
    ).toBeNull();
  });

  test("projects a provider reversal as a compensating revenue debit", () => {
    expect(
      revenueLedgerEntry(
        event({
          status: "reversed",
          settledAt: undefined,
          occurredAt: new Date("2026-09-28T00:00:00Z"),
        }),
      ),
    ).toMatchObject({
      idempotencyKey: "revenue:saas:invoice-1:reversed",
      type: "revenue_reversal",
      direction: "debit",
      status: "settled",
      amountMinor: 25_000n,
    });
  });

  test("settled revenue must carry reconciliation time", () => {
    expect(() => revenueLedgerEntry(event({ settledAt: undefined }))).toThrow(
      "settled revenue requires settledAt",
    );
  });

  test("deduplicates provider retries and keeps the furthest reconciliation state", () => {
    const pending = event({
      status: "pending",
      settledAt: undefined,
    });
    const settled = event();

    expect(dedupeRevenueEvents([pending, settled])).toEqual([settled]);
  });

  test("refuses provider identity reuse with conflicting financial terms", () => {
    expect(() =>
      dedupeRevenueEvents([event(), event({ amountMinor: 99_000n })]),
    ).toThrow(
      "revenue event identity was reused for conflicting financial terms",
    );
  });

  test("does not deduplicate the same external id across adapters", () => {
    const events = dedupeRevenueEvents([
      event({ adapterId: "saas-a" }),
      event({ adapterId: "saas-b" }),
    ]);
    expect(events).toHaveLength(2);
  });
});
