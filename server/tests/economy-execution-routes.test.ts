import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import { createLivePaymentRoutes } from "../src/economy/execution-routes";
import type { LiveChildFundingExecutor } from "../src/economy/live-child-funding-executor";
import type {
  LiveOperatingPaymentExecutor,
  LiveOperatingPaymentResult,
} from "../src/economy/live-payment-executor";
import { LiveOperatingPaymentUnsupportedError } from "../src/economy/live-payment-executor";
import type { LiveOwnerPayoutExecutor } from "../src/economy/live-owner-payout-executor";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "../src/economy/payment-intent-store";

type Actor = AppVariables["actor"];

const OWNER: Actor = {
  id: "owner-a",
  email: "owner@example.test",
  role: "user",
};

function authenticatedAs(
  actor: Actor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function profiles(ownerUserId = OWNER.id): AgentProfileStore {
  return {
    get: async (_actor, id) =>
      id === "agent-a"
        ? ({
            id: "agent-a",
            name: "Agent A",
            title: "Agent A",
            roleDescription: "test",
            avatarSeed: "agent-a",
            visibility: "public",
            ownerUserId,
            systemOwned: false,
            hidden: false,
            deletedAt: null,
            endpoint: null,
            hasAuth: false,
            hasCallbackToken: false,
            computerResourceProfile: "balanced",
          } as Awaited<ReturnType<AgentProfileStore["get"]>>)
        : null,
  } as unknown as AgentProfileStore;
}

const durableIntent: DurablePaymentIntent = {
  id: "intent-1",
  agentId: "agent-a",
  accountId: "account-a",
  idempotencyKey: "pay-1",
  kind: "OPERATING_EXPENSE",
  amountMinor: 1250n,
  assetCode: "USDC",
  provider: "circle",
  destination: "vendor-wallet",
  category: "api",
  decision: "ALLOW",
  policyVersion: 7,
};

function reader(
  value: DurablePaymentIntent = durableIntent,
): PaymentIntentReader {
  return {
    load: async (id) => (id === value.id ? value : null),
  };
}

function result(): LiveOperatingPaymentResult {
  return {
    receipt: {
      intentId: "intent-1",
      agentId: "agent-a",
      accountId: "account-a",
      provider: "circle",
      externalReference: "0xabc",
      providerStatus: "verified",
      assetCode: "USDC",
      amountMinor: 1250n,
      destination: "vendor-wallet",
      balanceBeforeMinor: 10_000n,
      balanceAfterMinor: 8_750n,
      verifiedAt: new Date("2026-09-28T00:00:00.000Z"),
    },
    ledgerEntry: {
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
    },
  };
}

function testApp(
  executor: LiveOperatingPaymentExecutor,
  profileStore: AgentProfileStore = profiles(),
  actor: Actor = OWNER,
  options: {
    intent?: DurablePaymentIntent;
    ownerPayoutExecutor?: LiveOwnerPayoutExecutor;
    childFundingExecutor?: LiveChildFundingExecutor;
  } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/economy/payment-intents",
    createLivePaymentRoutes({
      executor,
      ...(options.ownerPayoutExecutor
        ? { ownerPayoutExecutor: options.ownerPayoutExecutor }
        : {}),
      ...(options.childFundingExecutor
        ? { childFundingExecutor: options.childFundingExecutor }
        : {}),
      intentReader: reader(options.intent),
      profiles: profileStore,
      requireUser: authenticatedAs(actor),
    }),
  );
  return app;
}

describe("Agent Economy live payment routes", () => {
  test("executes for the actual Owner and forwards no mutable payment terms", async () => {
    let received:
      | Parameters<LiveOperatingPaymentExecutor["execute"]>[0]
      | undefined;
    const app = testApp({
      execute: async (input) => {
        received = input;
        return result();
      },
    });

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "attacker-provider",
          amountMinor: "999999",
          destination: "attacker-wallet",
          decision: "ALLOW",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({
      intentId: "intent-1",
      actorUserId: "owner-a",
    });
    expect(await response.json()).toMatchObject({
      payment: {
        intentId: "intent-1",
        provider: "circle",
        amountMinor: "1250",
        ledgerEntryId: "ledger-1",
      },
    });
  });

  test("public visibility does not grant payment execution authority", async () => {
    let calls = 0;
    const app = testApp(
      {
        execute: async () => {
          calls += 1;
          return result();
        },
      },
      profiles("another-owner"),
    );

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("forwards only a string approval id when present", async () => {
    let received:
      | Parameters<LiveOperatingPaymentExecutor["execute"]>[0]
      | undefined;
    const app = testApp({
      execute: async (input) => {
        received = input;
        return result();
      },
    });

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: " approval-1 " }),
      },
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({
      intentId: "intent-1",
      actorUserId: "owner-a",
      approvalId: "approval-1",
    });

    const invalid = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: 123 }),
      },
    );
    expect(invalid.status).toBe(400);
  });

  test("dispatches Owner payouts only to the specialized payout executor", async () => {
    let operatingCalls = 0;
    let payoutInput:
      | Parameters<LiveOwnerPayoutExecutor["execute"]>[0]
      | undefined;

    const ownerIntent: DurablePaymentIntent = {
      ...durableIntent,
      kind: "OWNER_PAYOUT",
      category: "owner_payout",
      destination: "owner-wallet",
    };

    const app = testApp(
      {
        execute: async () => {
          operatingCalls += 1;
          return result();
        },
      },
      profiles(),
      OWNER,
      {
        intent: ownerIntent,
        ownerPayoutExecutor: {
          execute: async (input) => {
            payoutInput = input;
            return {
              ...result(),
              pnlBeforePayout: {
                grossRevenueMinor: 50_000n,
                operatingCostMinor: 10_000n,
                operatingProfitMinor: 40_000n,
                reserveAllocationMinor: 8_000n,
                reinvestmentMinor: 12_000n,
                distributableProfitBeforePayoutMinor: 20_000n,
                ownerPayoutMinor: 0n,
                availableDistributableProfitMinor: 20_000n,
                totalInvestmentMinor: 0n,
                roiBasisPoints: null,
              },
            };
          },
        },
      },
    );

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: "999999",
          destination: "attacker-wallet",
          provider: "attacker-provider",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(operatingCalls).toBe(0);
    expect(payoutInput).toEqual({
      intentId: "intent-1",
      actorUserId: "owner-a",
    });
  });

  test("dispatches child funding only to the specialized child executor", async () => {
    let operatingCalls = 0;
    let childInput:
      | Parameters<LiveChildFundingExecutor["execute"]>[0]
      | undefined;

    const childIntent: DurablePaymentIntent = {
      ...durableIntent,
      kind: "CHILD_FUNDING",
      category: "child_funding",
      destination: "child-wallet",
    };

    const app = testApp(
      {
        execute: async () => {
          operatingCalls += 1;
          return result();
        },
      },
      profiles(),
      OWNER,
      {
        intent: childIntent,
        childFundingExecutor: {
          execute: async (input) => {
            childInput = input;
            return {
              ...result(),
              funding: {
                event: {
                  id: "funding-event-1",
                  relationshipId: "relationship-1",
                  intentId: "intent-1",
                  receiptId: "receipt-1",
                  parentAgentId: "agent-a",
                  childAgentId: "child-a",
                  amountMinor: 1250n,
                  assetCode: "USDC",
                  policyVersion: 7,
                  fundedAt: new Date("2026-09-28T00:00:00.000Z"),
                },
                parentLedgerEntry: result().ledgerEntry,
                childLedgerEntry: {
                  ...result().ledgerEntry,
                  id: "child-ledger-1",
                  agentId: "child-a",
                  accountId: "child-account",
                  idempotencyKey: "ledger:child-funding:child:pay-1",
                  type: "investment",
                  direction: "credit",
                },
              },
              childLedgerEntry: {
                ...result().ledgerEntry,
                id: "child-ledger-1",
                agentId: "child-a",
                accountId: "child-account",
                idempotencyKey: "ledger:child-funding:child:pay-1",
                type: "investment",
                direction: "credit",
              },
            };
          },
        },
      },
    );

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: "999999",
          destination: "attacker-wallet",
          relationshipId: "attacker-relationship",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(operatingCalls).toBe(0);
    expect(childInput).toEqual({
      intentId: "intent-1",
      actorUserId: "owner-a",
    });
  });

  test("returns conflict for payment kinds that require specialized execution", async () => {
    const app = testApp({
      execute: async () => {
        throw new LiveOperatingPaymentUnsupportedError(
          "this payment kind requires a specialized execution path",
        );
      },
    });

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/execute",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
  });
});
