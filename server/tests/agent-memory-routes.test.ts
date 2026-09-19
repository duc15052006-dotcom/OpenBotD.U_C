import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentMemoryRoutes } from "../src/agents/memory-routes";
import {
  AgentMemoryConflictError,
  type AgentMemoryStore,
} from "../src/agents/memory-store";
import type { AppVariables } from "../src/auth/guards";

type Actor = AppVariables["actor"];
const OWNER: Actor = { id: "owner", email: "owner@example.test", role: "user" };

const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  context.set("actor", OWNER);
  await next();
};

function fake(overrides: Partial<AgentMemoryStore> = {}): AgentMemoryStore {
  return {
    get: async () => ({ memory: "", revisionId: null, canManage: true }),
    history: async () => ({ revisions: [], canManage: true }),
    diff: async () => ({
      revision: { id: "r1", createdAt: "2026-09-19T00:00:00.000Z", kind: "edit", characters: 0, preview: "" },
      lines: [],
    }),
    update: async (_actor, _agentId, input) => ({
      memory: input.memory,
      revisionId: "next",
      canManage: true,
    }),
    undo: async () => ({ memory: "restored", revisionId: "undo", canManage: true }),
    ...overrides,
  };
}

function app(store: AgentMemoryStore) {
  const value = new Hono<{ Variables: AppVariables }>();
  value.route("/api/agents", createAgentMemoryRoutes(store, auth));
  return value;
}

describe("Agent memory routes", () => {
  test("passes base revision through on save", async () => {
    let seen: unknown;
    const response = await app(fake({
      update: async (_actor, _agentId, input) => {
        seen = input;
        return { memory: input.memory, revisionId: "r2", canManage: true };
      },
    })).request("/api/agents/writer/memory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memory: "  stable fact  ", baseRevisionId: "r1" }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual({ memory: "stable fact", baseRevisionId: "r1" });
  });

  test("maps stale saves to conflict instead of overwriting", async () => {
    const response = await app(fake({
      update: async () => { throw new AgentMemoryConflictError(); },
    })).request("/api/agents/writer/memory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memory: "stale", baseRevisionId: "old" }),
    });
    expect(response.status).toBe(409);
  });

  test("rejects malformed undo before store call", async () => {
    let called = false;
    const response = await app(fake({
      undo: async () => {
        called = true;
        return { memory: "", revisionId: null, canManage: true };
      },
    })).request("/api/agents/writer/memory/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: "", baseRevisionId: null }),
    });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
