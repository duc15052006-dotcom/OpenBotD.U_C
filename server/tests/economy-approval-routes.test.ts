import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createOwnerPaymentApprovalRoutes } from "../src/economy/approval-routes";
import {
  OwnerPaymentApprovalForbiddenError,
  OwnerPaymentApprovalNotRequiredError,
  type OwnerPaymentApprovalStore,
} from "../src/economy/approval-store";

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

function store(
  overrides: Partial<OwnerPaymentApprovalStore> = {},
): OwnerPaymentApprovalStore {
  return {
    approve: async ({ intentId, actorUserId }) => ({
      id: "approval-1",
      intentId,
      agentId: "agent-a",
      policyVersion: 7,
      approverKind: "OWNER",
      approverId: actorUserId,
      approvedAt: new Date("2026-09-28T00:00:00.000Z"),
    }),
    load: async () => null,
    ...overrides,
  };
}

function testApp(approvals: OwnerPaymentApprovalStore, actor: Actor = OWNER) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/economy/payment-intents",
    createOwnerPaymentApprovalRoutes(approvals, authenticatedAs(actor)),
  );
  return app;
}

describe("Agent Economy Owner approval routes", () => {
  test("creates an approval using only the authenticated Owner and intent id", async () => {
    let input: Parameters<OwnerPaymentApprovalStore["approve"]>[0] | undefined;
    const app = testApp(
      store({
        approve: async (value) => {
          input = value;
          return {
            id: "approval-1",
            intentId: value.intentId,
            agentId: "agent-a",
            policyVersion: 7,
            approverKind: "OWNER",
            approverId: value.actorUserId,
            approvedAt: new Date("2026-09-28T00:00:00.000Z"),
          };
        },
      }),
    );

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/approve",
      { method: "POST" },
    );

    expect(response.status).toBe(201);
    expect(input).toEqual({
      intentId: "intent-1",
      actorUserId: "owner-a",
      metadata: { source: "owner_http" },
    });
    expect(await response.json()).toEqual({
      approval: {
        id: "approval-1",
        intentId: "intent-1",
        agentId: "agent-a",
        policyVersion: 7,
        approvedAt: "2026-09-28T00:00:00.000Z",
      },
    });
  });

  test("hides another Owner's intent behind 404", async () => {
    const app = testApp(
      store({
        approve: async () => {
          throw new OwnerPaymentApprovalForbiddenError();
        },
      }),
    );

    const response = await app.request(
      "/api/economy/payment-intents/private-intent/approve",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Payment intent not found.",
    });
  });

  test("returns conflict when an intent never required Owner confirmation", async () => {
    const app = testApp(
      store({
        approve: async () => {
          throw new OwnerPaymentApprovalNotRequiredError("intent-1");
        },
      }),
    );

    const response = await app.request(
      "/api/economy/payment-intents/intent-1/approve",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
  });
});
