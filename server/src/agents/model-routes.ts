import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  AgentModelCredentialRequiredError,
  type AgentModelConfigStore,
} from "./model-config-store";
import { parseAgentModelConfigInput } from "./model-config";
import {
  AgentNotFoundError,
  AgentNotManageableError,
} from "./profile-store";

/**
 * HTTP surface for one Bot's model override.
 *
 * Kept out of the main agent lifecycle router on purpose: identity/profile management and runtime
 * model management have different authorization rules. In particular, a package-owned Bot cannot
 * have its profile edited, but an administrator may still override the model it runs on.
 */
export function createAgentModelRoutes(
  store: AgentModelConfigStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:agentId/model", requireUser, async (context) => {
    try {
      const model = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      return context.json({ model });
    } catch (error) {
      return modelRouteError(context, error);
    }
  });

  routes.put("/:agentId/model", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = parseAgentModelConfigInput(body);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }

    try {
      const model = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        parsed.value,
      );
      return context.json({ model });
    } catch (error) {
      return modelRouteError(context, error);
    }
  });

  return routes;
}

function modelRouteError(
  context: Parameters<Parameters<ReturnType<typeof createAgentModelRoutes>["onError"]>[0]>[0],
  error: unknown,
) {
  if (error instanceof AgentNotFoundError) {
    // Match the rest of the agent surface: an inaccessible id is indistinguishable from an absent
    // one, so a settings probe cannot enumerate private coworkers.
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json({ error: "Agent model settings cannot be changed by this user." }, 403);
  }
  if (error instanceof AgentModelCredentialRequiredError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
