import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAgentModelConfigRoutes } from "../src/agents/model-config-routes";
import type { AgentModelConfigStore } from "../src/agents/model-config-store";
import { AgentNotManageableError } from "../src/agents/profile-store";

const ACTOR: AppVariables["actor"] = {
  id: "owner",
  email: "owner@example.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", ACTOR);
  await next();
};

const models: AgentModelConfigStore = {
  get: async () => ({ mode: "global" }),
  update: async () => ({ mode: "global" }),
  resolve: async () => null,
  resolveManaged: async () => null,
};

function appWith(
  connections?: Parameters<typeof createAgentModelConfigRoutes>[2],
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/agents",
    createAgentModelConfigRoutes(models, requireUser, connections),
  );
  return app;
}

describe("agent model Test Connection route", () => {
  test("is not mounted when a safe connection service was not provided", async () => {
    const response = await appWith().request("/api/agents/writer/model/test", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("returns the secret-safe connection result", async () => {
    let seen: { actorId: string; agentId: string } | undefined;
    const response = await appWith({
      test: async (actor, agentId) => {
        seen = { actorId: actor.id, agentId };
        return {
          ok: true,
          provider: "google",
          model: "gemini-2.5-pro",
        };
      },
    }).request("/api/agents/writer/model/test", { method: "POST" });

    expect(response.status).toBe(200);
    expect(seen).toEqual({ actorId: "owner", agentId: "writer" });
    expect(await response.json()).toEqual({
      connection: {
        ok: true,
        provider: "google",
        model: "gemini-2.5-pro",
      },
    });
  });

  test("keeps management authorization failures as 403", async () => {
    const response = await appWith({
      test: async () => {
        throw new AgentNotManageableError("shared-agent");
      },
    }).request("/api/agents/shared-agent/model/test", { method: "POST" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Agent model settings cannot be managed by this actor.",
    });
  });
});
