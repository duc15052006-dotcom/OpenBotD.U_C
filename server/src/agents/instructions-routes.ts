import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { parseAgentInstructionsInput } from "./instructions";
import type { AgentInstructionsStore } from "./instructions-store";
import { AgentNotFoundError, AgentNotManageableError } from "./profile-store";

/** Authenticated HTTP surface for one Agent's durable instruction override. */
export function createAgentInstructionsRoutes(
  instructions: AgentInstructionsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:agentId/instructions", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      return context.json({
        instructions: await instructions.get(context.var.actor, agentId),
      });
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return context.json({ error: "Agent not found." }, 404);
      }
      throw error;
    }
  });

  routes.put("/:agentId/instructions", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    const parsed = parseAgentInstructionsInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }

    try {
      return context.json({
        instructions: await instructions.update(
          context.var.actor,
          agentId,
          parsed.value,
        ),
      });
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return context.json({ error: "Agent not found." }, 404);
      }
      if (error instanceof AgentNotManageableError) {
        return context.json(
          { error: "Agent instructions cannot be managed by this actor." },
          403,
        );
      }
      throw error;
    }
  });

  return routes;
}
