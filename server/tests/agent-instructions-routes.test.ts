import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentInstructionsRoutes } from "../src/agents/instructions-routes";
import type { AgentInstructionsStore } from "../src/agents/instructions-store";
import {
  AgentNotFoundError,
  AgentNotManageableError,
} from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";

type Actor = AppVariables["actor"];

const OWNER: Actor = {
  id: "user-owner",
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
  overrides: Partial<AgentInstructionsStore> = {},
): AgentInstructionsStore {
  return {
    get: async () => ({ instructions: "", canManage: true }),
    update: async (_actor, _agentId, input) => ({
      instructions: input.instructions,
      canManage: true,
    }),
    ...overrides,
  };
}

function testApp(instructions: AgentInstructionsStore, actor: Actor = OWNER) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/agents",
    createAgentInstructionsRoutes(instructions, authenticatedAs(actor)),
  );
  return app;
}

describe("agent instruction routes", () => {
  test("GET returns the settings visible to the authenticated actor", async () => {
    let seen: Actor | undefined;
    const app = testApp(
      store({
        get: async (actor) => {
          seen = actor as Actor;
          return {
            instructions: "Verify every claim.",
            canManage: true,
          };
        },
      }),
    );

    const response = await app.request("/api/agents/writer/instructions");

    expect(response.status).toBe(200);
    expect(seen).toEqual(OWNER);
    expect(await response.json()).toEqual({
      instructions: {
        instructions: "Verify every claim.",
        canManage: true,
      },
    });
  });

  test("PUT trims valid text before the store sees it", async () => {
    let received: string | undefined;
    const app = testApp(
      store({
        update: async (_actor, _agentId, input) => {
          received = input.instructions;
          return { instructions: input.instructions, canManage: true };
        },
      }),
    );

    const response = await app.request("/api/agents/writer/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "  Be concise.  " }),
    });

    expect(response.status).toBe(200);
    expect(received).toBe("Be concise.");
    expect(await response.json()).toEqual({
      instructions: { instructions: "Be concise.", canManage: true },
    });
  });

  test("PUT accepts empty text as an explicit clear", async () => {
    let received: string | undefined;
    const app = testApp(
      store({
        update: async (_actor, _agentId, input) => {
          received = input.instructions;
          return { instructions: "", canManage: true };
        },
      }),
    );

    const response = await app.request("/api/agents/writer/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "   " }),
    });

    expect(response.status).toBe(200);
    expect(received).toBe("");
  });

  test("rejects malformed input before any write", async () => {
    let writes = 0;
    const app = testApp(
      store({
        update: async () => {
          writes += 1;
          return { instructions: "", canManage: true };
        },
      }),
    );

    const response = await app.request("/api/agents/writer/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: 42 }),
    });

    expect(response.status).toBe(400);
    expect(writes).toBe(0);
  });

  test("does not reveal inaccessible Agents", async () => {
    const app = testApp(
      store({
        get: async () => {
          throw new AgentNotFoundError("private-agent");
        },
      }),
    );

    const response = await app.request(
      "/api/agents/private-agent/instructions",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
  });

  test("preserves the store authorization boundary on writes", async () => {
    const app = testApp(
      store({
        update: async () => {
          throw new AgentNotManageableError("shared-agent");
        },
      }),
    );

    const response = await app.request(
      "/api/agents/shared-agent/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "Change behavior." }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Agent instructions cannot be managed by this actor.",
    });
  });
});
