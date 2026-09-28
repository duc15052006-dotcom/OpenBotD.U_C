import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import { createLivePaymentRoutes } from "../src/economy/execution-routes";
import type {
  LiveOperatingPaymentExecutor,
  LiveOperatingPaymentResult,
} from "../src/economy/live-payment-executor";
import { LiveOperatingPaymentUnsupportedError } from "../src/economy/live-payment-executor";
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

function reader(): PaymentIntentReader {
  return {
    load: async (id) => (id === durableIntent.id ? durableIntent : null),
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
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/economy/payment-intents",
    createLivePaymentRoutes({
      executor,
      intentReader: reader(),
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
