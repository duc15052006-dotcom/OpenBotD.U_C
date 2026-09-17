import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentModelConfigStore } from "../src/agents/model-config-store";
import { AgentModelCredentialRequiredError } from "../src/agents/model-config-store";
import { createAgentModelRoutes } from "../src/agents/model-routes";
import {
  AgentNotFoundError,
  AgentNotManageableError,
} from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";

const actor = {
  id: "user-1",
  email: "user@openbot.test",
  role: "user",
} as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(store: AgentModelConfigStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAgentModelRoutes(store, requireUser));
  return app;
}

function fakeStore(overrides: Partial<AgentModelConfigStore> = {}) {
  const calls: unknown[][] = [];
  const store: AgentModelConfigStore = {
    async get(receivedActor, agentId) {
      calls.push(["get", receivedActor, agentId]);
      return { mode: "global" };
    },
    async update(receivedActor, agentId, input) {
      calls.push(["update", receivedActor, agentId, input]);
      return input.mode === "global"
        ? { mode: "global" }
        : {
            mode: "custom",
            provider: input.provider,
            model: input.model,
            hasApiKey: input.credentialSource === "custom",
            ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
            ...(input.temperature !== undefined
              ? { temperature: input.temperature }
              : {}),
            ...(input.maxTokens !== undefined
              ? { maxTokens: input.maxTokens }
              : {}),
            ...(input.fallback ? { fallback: input.fallback } : {}),
          };
    },
    async resolve() {
      return null;
    },
    async resolveManaged() {
      return null;
    },
    ...overrides,
  };
  return Object.assign(store, { calls });
}

describe("agent model routes", () => {
  test("reads the browser-safe model config with the authenticated actor", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/agent-1/model",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ model: { mode: "global" } });
    expect(store.calls).toEqual([["get", actor, "agent-1"]]);
  });

  test("validates before calling the store", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/agent-1/model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "custom",
          provider: "anthropic",
          model: "claude-sonnet",
          credentialSource: "global",
          baseUrl: "https://proxy.example/v1",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  test("normalizes a valid custom config before persisting it", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/agent-1/model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "custom",
          provider: "google",
          model: "  gemini-2.5-pro  ",
          credentialSource: "custom",
          apiKey: "  secret  ",
          temperature: 0.3,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([
      [
        "update",
        actor,
        "agent-1",
        {
          mode: "custom",
          provider: "google",
          model: "gemini-2.5-pro",
          credentialSource: "custom",
          apiKey: "secret",
          temperature: 0.3,
        },
      ],
    ]);
    const body = (await response.json()) as { model: Record<string, unknown> };
    expect(body.model.apiKey).toBeUndefined();
  });

  test("does not reveal inaccessible agent ids", async () => {
    const store = fakeStore({
      async get(_actor, id) {
        throw new AgentNotFoundError(id);
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/private-agent/model",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
  });

  test("maps management and credential failures to explicit client errors", async () => {
    const notManageable = fakeStore({
      async update(_actor, id) {
        throw new AgentNotManageableError(id);
      },
    });
    const forbidden = await appFor(notManageable).request(
      "http://openbot.test/agent-1/model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "global" }),
      },
    );
    expect(forbidden.status).toBe(403);

    const missingKey = fakeStore({
      async update(_actor, id) {
        throw new AgentModelCredentialRequiredError(id);
      },
    });
    const badRequest = await appFor(missingKey).request(
      "http://openbot.test/agent-1/model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "custom",
          provider: "openai",
          model: "gpt-5.6",
          credentialSource: "custom",
        }),
      },
    );
    expect(badRequest.status).toBe(400);
  });
});
