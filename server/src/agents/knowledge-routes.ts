import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  MAX_AGENT_KNOWLEDGE_FILE_BYTES,
  parseAgentKnowledgeUpload,
} from "./knowledge";
import {
  type AgentKnowledgeStore,
  AgentKnowledgeDocumentNotFoundError,
  AgentKnowledgeLimitError,
} from "./knowledge-store";
import { AgentNotFoundError, AgentNotManageableError } from "./profile-store";

export function createAgentKnowledgeRoutes(
  knowledge: AgentKnowledgeStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const mapError = (
    context: Context<{ Variables: AppVariables }>,
    error: unknown,
  ) => {
    if (error instanceof AgentNotFoundError) {
      return context.json({ error: "Agent not found." }, 404);
    }
    if (error instanceof AgentNotManageableError) {
      return context.json(
        { error: "Agent knowledge cannot be managed by this actor." },
        403,
      );
    }
    if (error instanceof AgentKnowledgeDocumentNotFoundError) {
      return context.json({ error: "Knowledge document not found." }, 404);
    }
    if (error instanceof AgentKnowledgeLimitError) {
      return context.json({ error: error.message }, 400);
    }
    throw error;
  };

  routes.get("/:agentId/knowledge", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      return context.json({
        knowledge: await knowledge.list(context.var.actor, agentId),
      });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/:agentId/knowledge", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    const parsed = parseAgentKnowledgeUpload(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    if (parsed.value.bytes.length > MAX_AGENT_KNOWLEDGE_FILE_BYTES) {
      return context.json({ error: "Knowledge file is too large." }, 400);
    }

    try {
      return context.json({
        knowledge: await knowledge.add(
          context.var.actor,
          agentId,
          parsed.value,
        ),
      });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.delete(
    "/:agentId/knowledge/:documentId",
    requireUser,
    async (context) => {
      const agentId = context.req.param("agentId").trim();
      const documentId = context.req.param("documentId").trim();
      if (!agentId || !documentId) {
        return context.json(
          { error: "A Bot id and knowledge document id are required." },
          400,
        );
      }
      try {
        return context.json({
          knowledge: await knowledge.remove(
            context.var.actor,
            agentId,
            documentId,
          ),
        });
      } catch (error) {
        return mapError(context, error);
      }
    },
  );

  return routes;
}
