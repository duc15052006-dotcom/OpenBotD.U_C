import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import { createPaymentIntentRoutes } from "../src/economy/intent-routes";
import {
  PaymentIntentAccountForbiddenError,
  PaymentIntentCreationConflictError,
  type PaymentIntentCreator,
} from "../src/economy/payment-intent-creator";

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

function creator(
  overrides: Partial<PaymentIntentCreator> = {},
): PaymentIntentCreator {
  return {
    create: async (input) => ({
      id: "intent-1",
      agentId: input.intent.agentId,
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      kind: input.intent.kind,
      amountMinor: input.intent.amountMinor,
      assetCode: "USDC",
      provider: "mock-provider",
      destination: input.intent.destination,
      category: input.intent.category,
      ...(input.intent.x402Domain
        ? { x402Domain: input.intent.x402Domain }
        : {}),
      decision: "ALLOW",
      policyVersion: 7,
      decisionReason: "financial policy allows payment",
      initiatorKind: input.initiator.kind,
      initiatorId:
        input.initiator.kind === "deployment" ? null : input.initiator.id,
      requestedAt: new Date("2026-09-28T00:00:00.000Z"),
    }),
    ...overrides,
  };
}

function testApp(
  paymentIntents: PaymentIntentCreator,
  profileStore: AgentProfileStore = profiles(),
  actor: Actor = OWNER,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/economy/payment-intents",
    createPaymentIntentRoutes(
      paymentIntents,
      profileStore,
      authenticatedAs(actor),
    ),
  );
  return app;
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: "pay-1",
    kind: "OPERATING_EXPENSE",
    amountMinor: "1250",
    destination: "vendor-wallet",
    category: "api",
    ...overrides,
  };
}

describe("Agent Economy payment intent routes", () => {
  test("creates an Owner-originated intent without forwarding client policy fields", async () => {
    let received: Parameters<PaymentIntentCreator["create"]>[0] | undefined;
    const app = testApp(
      creator({
        create: async (input) => {
          received = input;
          return creator().create(input);
        },
      }),
    );

    const response = await app.request("/api/economy/payment-intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        requestBody({
          decision: "ALLOW",
          policyVersion: 999,
          snapshot: { frozen: false },
          metadata: { injected: true },
        }),
      ),
    });

    expect(response.status).toBe(201);
    expect(received).toEqual({
      accountId: "account-a",
      idempotencyKey: "pay-1",
      intent: {
        agentId: "agent-a",
        kind: "OPERATING_EXPENSE",
        amountMinor: 1250n,
        destination: "vendor-wallet",
        category: "api",
      },
      initiator: { kind: "person", id: "owner-a" },
    });
    expect(await response.json()).toMatchObject({
      intent: {
        id: "intent-1",
        amountMinor: "1250",
        decision: "ALLOW",
        policyVersion: 7,
      },
    });
  });

  test("public visibility does not let another user create financial intents", async () => {
    let createCalls = 0;
    const app = testApp(
      creator({
        create: async (input) => {
          createCalls += 1;
          return creator().create(input);
        },
      }),
      profiles("another-owner"),
    );

    const response = await app.request("/api/economy/payment-intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });

    expect(response.status).toBe(404);
    expect(createCalls).toBe(0);
  });

  test("rejects non-string minor units before the creator boundary", async () => {
    const app = testApp(creator());

    const response = await app.request("/api/economy/payment-intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody({ amountMinor: 1250 })),
    });

    expect(response.status).toBe(400);
  });

  test("hides a foreign financial account and reports idempotency conflicts", async () => {
    const accountApp = testApp(
      creator({
        create: async () => {
          throw new PaymentIntentAccountForbiddenError();
        },
      }),
    );
    const accountResponse = await accountApp.request(
      "/api/economy/payment-intents",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      },
    );
    expect(accountResponse.status).toBe(404);

    const conflictApp = testApp(
      creator({
        create: async () => {
          throw new PaymentIntentCreationConflictError("pay-1");
        },
      }),
    );
    const conflictResponse = await conflictApp.request(
      "/api/economy/payment-intents",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      },
    );
    expect(conflictResponse.status).toBe(409);
  });
});
