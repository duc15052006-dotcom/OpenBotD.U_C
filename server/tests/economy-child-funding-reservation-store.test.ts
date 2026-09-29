import { describe, expect, test } from "bun:test";
import {
  calculateCommittedChildFundingMinor,
  ChildFundingReservationRefusedError,
} from "../src/economy/child-funding-reservation-store";

const NOW = new Date("2026-09-29T00:00:00.000Z");

describe("Agent Economy child funding reservation budget", () => {
  test("counts funded events and does not double-count their reservations", () => {
    expect(
      calculateCommittedChildFundingMinor({
        events: [{ intentId: "funded", amountMinor: "5000" }],
        reservations: [
          {
            intentId: "funded",
            amountMinor: "5000",
            reservedUntil: new Date("2026-09-29T00:10:00.000Z"),
          },
        ],
        verifiedReceiptIntentIds: new Set(["funded"]),
        now: NOW,
      }),
    ).toBe(5000n);
  });

  test("holds active reservations before any provider transfer completes", () => {
    expect(
      calculateCommittedChildFundingMinor({
        events: [],
        reservations: [
          {
            intentId: "reserved",
            amountMinor: "7000",
            reservedUntil: new Date("2026-09-29T00:10:00.000Z"),
          },
        ],
        verifiedReceiptIntentIds: new Set(),
        now: NOW,
      }),
    ).toBe(7000n);
  });

  test("releases an expired reservation when no verified receipt exists", () => {
    expect(
      calculateCommittedChildFundingMinor({
        events: [],
        reservations: [
          {
            intentId: "expired",
            amountMinor: "7000",
            reservedUntil: new Date("2026-09-28T23:59:59.000Z"),
          },
        ],
        verifiedReceiptIntentIds: new Set(),
        now: NOW,
      }),
    ).toBe(0n);
  });

  test("keeps an expired reservation committed after a verified transfer", () => {
    expect(
      calculateCommittedChildFundingMinor({
        events: [],
        reservations: [
          {
            intentId: "orphan-receipt",
            amountMinor: "7000",
            reservedUntil: new Date("2026-09-28T23:59:59.000Z"),
          },
        ],
        verifiedReceiptIntentIds: new Set(["orphan-receipt"]),
        now: NOW,
      }),
    ).toBe(7000n);
  });

  test("fails closed on invalid durable budget evidence", () => {
    expect(() =>
      calculateCommittedChildFundingMinor({
        events: [{ intentId: "bad", amountMinor: "-1" }],
        reservations: [],
        verifiedReceiptIntentIds: new Set(),
        now: NOW,
      }),
    ).toThrow(ChildFundingReservationRefusedError);

    expect(() =>
      calculateCommittedChildFundingMinor({
        events: [],
        reservations: [
          {
            intentId: "bad",
            amountMinor: "not-money",
            reservedUntil: new Date("2026-09-29T00:10:00.000Z"),
          },
        ],
        verifiedReceiptIntentIds: new Set(),
        now: NOW,
      }),
    ).toThrow(ChildFundingReservationRefusedError);
  });
});
