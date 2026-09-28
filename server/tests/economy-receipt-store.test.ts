import { describe, expect, test } from "bun:test";
import type { VerifiedPaymentReceipt } from "../src/economy/execution";
import {
  PaymentReceiptIntegrityError,
  sameVerifiedPaymentTransfer,
  verifiedPaymentReceiptFromRow,
} from "../src/economy/receipt-store";

function receipt(
  overrides: Partial<VerifiedPaymentReceipt> = {},
): VerifiedPaymentReceipt {
  return {
    intentId: "intent-1",
    agentId: "agent-a",
    accountId: "account-a",
    provider: "circle",
    externalReference: "0xabc",
    providerStatus: "verified",
    assetCode: "USDC",
    amountMinor: 1_250_000n,
    destination: "owner-wallet",
    balanceBeforeMinor: 5_000_000n,
    balanceAfterMinor: 3_750_000n,
    verifiedAt: new Date("2026-09-28T02:00:00.000Z"),
    ...overrides,
  };
}

describe("Agent Economy verified receipt integrity", () => {
  test("fails closed when a durable receipt row is malformed", () => {
    expect(() =>
      verifiedPaymentReceiptFromRow({
        intentId: "intent-1",
        agentId: "agent-a",
        accountId: "account-a",
        provider: "circle",
        externalReference: "0xabc",
        providerStatus: "verified",
        assetCode: "USDC",
        amountMinor: "not-an-integer",
        destination: "owner-wallet",
        balanceBeforeMinor: "5000000",
        balanceAfterMinor: "3750000",
        verifiedAt: new Date("2026-09-28T02:00:00.000Z"),
      }),
    ).toThrow(PaymentReceiptIntegrityError);

    expect(() =>
      verifiedPaymentReceiptFromRow({
        intentId: "intent-1",
        agentId: "agent-a",
        accountId: "account-a",
        provider: "circle",
        externalReference: "0xabc",
        providerStatus: "pending",
        assetCode: "USDC",
        amountMinor: "1250000",
        destination: "owner-wallet",
        balanceBeforeMinor: "5000000",
        balanceAfterMinor: "3750000",
        verifiedAt: new Date("2026-09-28T02:00:00.000Z"),
      }),
    ).toThrow(PaymentReceiptIntegrityError);
  });

  test("concurrent observations of the same external transfer converge", () => {
    const first = receipt();
    const retry = receipt({
      balanceBeforeMinor: 3_750_000n,
      balanceAfterMinor: 3_750_000n,
      verifiedAt: new Date("2026-09-28T02:00:05.000Z"),
    });

    expect(sameVerifiedPaymentTransfer(first, retry)).toBe(true);
  });

  test("conflicting external transfer or financial terms never converge", () => {
    expect(
      sameVerifiedPaymentTransfer(
        receipt(),
        receipt({ externalReference: "0xdef" }),
      ),
    ).toBe(false);

    expect(
      sameVerifiedPaymentTransfer(
        receipt(),
        receipt({ destination: "another-wallet" }),
      ),
    ).toBe(false);

    expect(
      sameVerifiedPaymentTransfer(
        receipt(),
        receipt({ amountMinor: 1_249_999n }),
      ),
    ).toBe(false);
  });
});
