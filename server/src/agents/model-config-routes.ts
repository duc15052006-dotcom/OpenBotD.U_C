import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { parseAgentModelConfigInput } from "./model-config";
import type { AgentModelConnectionService } from "./model-connection-service";
import {
  AgentModelCredentialRequiredError,
  type AgentModelConfigStore,
} from "./model-config-store";
import {
  AgentNotFoundError,
  AgentNotManageableError,
} from "./profile-store";

/**
 * HTTP surface for one Bot's deployment-owned model override.
 *
 * Authorization deliberately stays in {@link AgentModelConfigStore}. The store is also used by
 * non-HTTP callers and is the only place that knows the one exception to normal profile management:
 * an administrator may configure the runtime model of a package-owned Bot without editing the
 * package-owned profile itself. Duplicating that rule here would create two boundaries that can
 * drift apart.
 */
export function createAgentModelConfigRoutes(
  models: AgentModelConfigStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Optional because safe probing requires a deployment-governed outbound fetch. If the caller did
   * not build one, there is no Test Connection route rather than a fallback to unrestricted fetch.
   */
  connections?: AgentModelConnectionService,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:agentId/model", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }

    try {
      return context.json({
        model: await models.get(context.var.actor, agentId),
      });
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        // `get` applies profile visibility before reading the override, so an inaccessible private
        // Bot is indistinguishable from an id that does not exist.
        return context.json({ error: "Agent not found." }, 404);
      }
      throw error;
    }
  });

  routes.put("/:agentId/model", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }

    const parsed = parseAgentModelConfigInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }

    try {
      return context.json({
        model: await models.update(context.var.actor, agentId, parsed.value),
      });
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return context.json({ error: "Agent not found." }, 404);
      }
      if (error instanceof AgentNotManageableError) {
        return context.json(
          { error: "Agent model settings cannot be managed by this actor." },
          403,
        );
      }
      if (error instanceof AgentModelCredentialRequiredError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  if (connections) {
    routes.post("/:agentId/model/test", requireUser, async (context) => {
      const agentId = context.req.param("agentId").trim();
      if (!agentId) {
        return context.json({ error: "A Bot id is required." }, 400);
      }

      try {
        return context.json({
          connection: await connections.test(context.var.actor, agentId),
        });
      } catch (error) {
        if (error instanceof AgentNotFoundError) {
          return context.json({ error: "Agent not found." }, 404);
        }
        if (error instanceof AgentNotManageableError) {
          return context.json(
            { error: "Agent model settings cannot be managed by this actor." },
            403,
          );
        }
        throw error;
      }
    });
  }

  return routes;
}
