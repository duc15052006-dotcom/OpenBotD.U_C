import { describe, expect, test } from "bun:test";
import {
  decidePaymentIntent,
  type EconomyExecutionPolicy,
  type PaymentIntent,
} from "../src/economy/intents";

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
  allowedPaymentAddresses: ["owner-wallet", "vendor-wallet", "child-wallet"],
  allowedPaymentCategories: [
    "owner_payout",
    "api",
    "child_funding",
    "x402",
  ],
  maxChildFundingMinor: 20_000n,
  maxX402PaymentMinor: 5_000n,
  allowedX402Domains: ["example.com", "api.vendor.test"],
  frozen: false,
};

const spend = { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n };

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    agentId: "agent-a",
    kind: "OPERATING_EXPENSE",
    amountMinor: 1_000n,
    destination: "vendor-wallet",
    category: "api",
    ...overrides,
  };
}

function decide(
  paymentIntent: PaymentIntent,
  overrides: Partial<Parameters<typeof decidePaymentIntent>[0]> = {},
) {
  return decidePaymentIntent({
    intent: paymentIntent,
    policy,
    settledBalanceMinor: 100_000n,
    availableDistributableProfitMinor: 20_000n,
    spend,
    ...overrides,
  });
}

describe("Agent Economy payment intent policy", () => {
  test("allows a small permitted operating expense", () => {
    expect(decide(intent())).toEqual({
      decision: "ALLOW",
      reason: "financial policy allows payment",
    });
  });

  test("kill switch denies every financial action before approval", () => {
    expect(
      decide(intent(), { policy: { ...policy, frozen: true } }),
    ).toEqual({
      decision: "DENY",
      reason: "financial activity is frozen",
    });
  });

  test("reserve protection is evaluated before Owner confirmation", () => {
    expect(
      decide(intent({ amountMinor: 15_000n }), {
        settledBalanceMinor: 20_000n,
      }),
    ).toEqual({
      decision: "DENY",
      reason: "payment would breach minimum reserve",
    });
  });

  test("enforces rolling spend windows", () => {
    expect(
      decide(intent({ amountMinor: 2_000n }), {
        spend: {
          hourlyMinor: 59_000n,
          dailyMinor: 59_000n,
          monthlyMinor: 59_000n,
        },
      }),
    ).toEqual({
      decision: "DENY",
      reason: "payment exceeds hourly spend limit",
    });
  });

  test("requires Owner confirmation only after all hard limits pass", () => {
    expect(decide(intent({ amountMinor: 15_000n }))).toEqual({
      decision: "OWNER_CONFIRMATION",
      reason: "payment exceeds Owner confirmation threshold",
    });
  });

  test("owner payout cannot exceed distributable profit", () => {
    expect(
      decide(
        intent({
          kind: "OWNER_PAYOUT",
          amountMinor: 9_000n,
          destination: "owner-wallet",
          category: "owner_payout",
        }),
        { availableDistributableProfitMinor: 8_000n },
      ),
    ).toEqual({
      decision: "DENY",
      reason: "owner payout exceeds distributable profit",
    });
  });

  test("child funding obeys its dedicated cap", () => {
    expect(
      decide(
        intent({
          kind: "CHILD_FUNDING",
          amountMinor: 21_000n,
          destination: "child-wallet",
          category: "child_funding",
        }),
      ),
    ).toEqual({
      decision: "DENY",
      reason: "child funding exceeds configured limit",
    });
  });

  test("x402 requires both amount cap and allowed domain", () => {
    expect(
      decide(
        intent({
          kind: "X402_PAYMENT",
          amountMinor: 1_000n,
          category: "x402",
          x402Domain: "service.example.com",
        }),
      ),
    ).toEqual({
      decision: "ALLOW",
      reason: "financial policy allows payment",
    });

    expect(
      decide(
        intent({
          kind: "X402_PAYMENT",
          amountMinor: 1_000n,
          category: "x402",
          x402Domain: "example.com.evil.test",
        }),
      ),
    ).toEqual({
      decision: "DENY",
      reason: "x402 destination domain is not allowed",
    });
  });

  test("whitelist is fail-closed when configured", () => {
    expect(decide(intent({ destination: "unknown-wallet" }))).toEqual({
      decision: "DENY",
      reason: "payment destination is not whitelisted",
    });
  });
});
