import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAgentModelConfigRoutes } from "../src/agents/model-config-routes";
import {
  AgentModelCredentialRequiredError,
  type AgentModelConfigStore,
} from "../src/agents/model-config-store";
import {
  AgentNotFoundError,
  AgentNotManageableError,
} from "../src/agents/profile-store";

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

function testApp(store: AgentModelConfigStore, actor: Actor = OWNER) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/agents",
    createAgentModelConfigRoutes(store, authenticatedAs(actor)),
  );
  return app;
}

function modelStore(
  overrides: Partial<AgentModelConfigStore> = {},
): AgentModelConfigStore {
  return {
    get: async () => ({ mode: "global" }),
    update: async () => ({ mode: "global" }),
    resolve: async () => null,
    resolveManaged: async () => null,
    ...overrides,
  };
}

describe("agent model configuration routes", () => {
  test("GET returns only browser-safe model state and passes the authenticated actor", async () => {
    let seenActor: Actor | undefined;
    const app = testApp(
      modelStore({
        get: async (actor) => {
          seenActor = actor as Actor;
          return {
            mode: "custom",
            provider: "openai",
            model: "gpt-5.6",
            credentialSource: "custom",
            temperature: 0.4,
            hasApiKey: true,
          };
        },
      }),
    );

    const response = await app.request("/api/agents/researcher/model");
    expect(response.status).toBe(200);
    expect(seenActor).toEqual(OWNER);

    const body = await response.json();
    expect(body).toEqual({
      model: {
        mode: "custom",
        provider: "openai",
        model: "gpt-5.6",
        credentialSource: "custom",
        temperature: 0.4,
        hasApiKey: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("credentialId");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });

  test("GET maps an inaccessible or missing agent to 404", async () => {
    const app = testApp(
      modelStore({
        get: async () => {
          throw new AgentNotFoundError("private-agent");
        },
      }),
    );

    const response = await app.request("/api/agents/private-agent/model");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
  });

  test("PUT rejects malformed input before calling the store", async () => {
    let updates = 0;
    const app = testApp(
      modelStore({
        update: async () => {
          updates += 1;
          return { mode: "global" };
        },
      }),
    );

    const response = await app.request("/api/agents/researcher/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    expect(updates).toBe(0);
  });

  test("PUT normalizes a write-only key and never returns it", async () => {
    let saved: Parameters<AgentModelConfigStore["update"]>[2] | undefined;
    let seenActor: Actor | undefined;
    const app = testApp(
      modelStore({
        update: async (actor, _agentId, input) => {
          seenActor = actor as Actor;
          saved = input;
          return {
            mode: "custom",
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            credentialSource: "custom",
            hasApiKey: true,
            temperature: 0.2,
            maxTokens: 4096,
          };
        },
      }),
    );

    const response = await app.request("/api/agents/writer/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "custom",
        provider: "anthropic",
        model: "  claude-sonnet-4.5  ",
        credentialSource: "custom",
        apiKey: "  super-secret  ",
        temperature: 0.2,
        maxTokens: 4096,
      }),
    });

    expect(response.status).toBe(200);
    expect(seenActor).toEqual(OWNER);
    expect(saved).toEqual({
      mode: "custom",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      credentialSource: "custom",
      apiKey: "super-secret",
      temperature: 0.2,
      maxTokens: 4096,
    });

    const body = await response.json();
    expect(body).toEqual({
      model: {
        mode: "custom",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        credentialSource: "custom",
        hasApiKey: true,
        temperature: 0.2,
        maxTokens: 4096,
      },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  test("PUT preserves the store's owner/admin authorization boundary", async () => {
    const app = testApp(
      modelStore({
        update: async () => {
          throw new AgentNotManageableError("public-agent");
        },
      }),
    );

    const response = await app.request("/api/agents/public-agent/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "global" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Agent model settings cannot be managed by this actor.",
    });
  });

  test("PUT turns a provider change without its required custom key into a client error", async () => {
    const app = testApp(
      modelStore({
        update: async () => {
          throw new AgentModelCredentialRequiredError("writer");
        },
      }),
    );

    const response = await app.request("/api/agents/writer/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "custom",
        provider: "google",
        model: "gemini-2.5-pro",
        credentialSource: "custom",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Agent writer needs an API key for its custom model provider.",
    });
  });
});
