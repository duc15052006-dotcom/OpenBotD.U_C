import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { parseAgentMemoryInput, parseAgentMemoryUndoInput } from "./memory";
import {
  AgentMemoryConflictError,
  AgentMemoryRevisionNotFoundError,
  type AgentMemoryStore,
} from "./memory-store";
import { AgentNotFoundError, AgentNotManageableError } from "./profile-store";

export function createAgentMemoryRoutes(
  memory: AgentMemoryStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const id = (context: { req: { param(name: string): string } }) => context.req.param("agentId").trim();

  routes.get("/:agentId/memory", requireUser, async (context) => {
    const agentId = id(context);
    if (!agentId) return context.json({ error: "A Bot id is required." }, 400);
    try {
      return context.json({ memory: await memory.get(context.var.actor, agentId) });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return context.json({ error: "Agent not found." }, 404);
      throw error;
    }
  });

  routes.get("/:agentId/memory/history", requireUser, async (context) => {
    const agentId = id(context);
    if (!agentId) return context.json({ error: "A Bot id is required." }, 400);
    try {
      return context.json({ history: await memory.history(context.var.actor, agentId) });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return context.json({ error: "Agent not found." }, 404);
      throw error;
    }
  });

  routes.get("/:agentId/memory/history/:revisionId", requireUser, async (context) => {
    const agentId = id(context);
    const revisionId = context.req.param("revisionId").trim();
    if (!agentId || !revisionId) return context.json({ error: "Bot id and revision id are required." }, 400);
    try {
      return context.json({ diff: await memory.diff(context.var.actor, agentId, revisionId) });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return context.json({ error: "Agent not found." }, 404);
      if (error instanceof AgentMemoryRevisionNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  routes.put("/:agentId/memory", requireUser, async (context) => {
    const agentId = id(context);
    const parsed = parseAgentMemoryInput(await context.req.json().catch(() => null));
    if (!agentId) return context.json({ error: "A Bot id is required." }, 400);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      return context.json({ memory: await memory.update(context.var.actor, agentId, parsed.value) });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return context.json({ error: "Agent not found." }, 404);
      if (error instanceof AgentNotManageableError) return context.json({ error: "Agent memory cannot be managed by this actor." }, 403);
      if (error instanceof AgentMemoryConflictError) return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  routes.post("/:agentId/memory/undo", requireUser, async (context) => {
    const agentId = id(context);
    const parsed = parseAgentMemoryUndoInput(await context.req.json().catch(() => null));
    if (!agentId) return context.json({ error: "A Bot id is required." }, 400);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      return context.json({ memory: await memory.undo(context.var.actor, agentId, parsed.value) });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return context.json({ error: "Agent not found." }, 404);
      if (error instanceof AgentNotManageableError) return context.json({ error: "Agent memory cannot be managed by this actor." }, 403);
      if (error instanceof AgentMemoryConflictError) return context.json({ error: error.message }, 409);
      if (error instanceof AgentMemoryRevisionNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  return routes;
}
