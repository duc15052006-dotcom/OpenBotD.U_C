import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  type AgentModelConfigInput,
  parseAgentModelConfigInput,
  type PublicAgentModelConfig,
} from "./model-config";
import {
  AgentModelCredentialRequiredError,
  AgentModelNotFoundError,
} from "./model-config-store";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

/**
 * The narrow store contract this HTTP surface needs.
 *
 * Kept structural rather than importing the concrete database store so the route owns no persistence
 * decisions. That also makes its permission and secret-redaction behaviour exercisable without a
 * database.
 */
export type AgentModelSettingsStore = {
  get(agentId: string): Promise<PublicAgentModelConfig>;
  save(
    agentId: string,
    input: AgentModelConfigInput,
  ): Promise<PublicAgentModelConfig>;
};

/**
 * Model settings are a different capability from editing an agent profile.
 *
 * A package-owned Bot is deliberately protected from profile edits because the package owns its
 * name, role and endpoint. The model is a deployment override, stored outside package configuration,
 * so an administrator may change it without claiming ownership of package data. Customer-created
 * Bots remain owner-managed, with administrators retaining the deployment-wide override they have
 * everywhere else.
 */
export function canManageAgentModel(
  actor: AgentActor,
  profile: AgentProfile,
): boolean {
  if (profile.deletedAt !== null) return false;
  if (actor.role === "admin") return true;
  return !profile.systemOwned && profile.ownerUserId === actor.id;
}

export function createAgentModelConfigRoutes(
  profiles: Pick<AgentProfileStore, "get">,
  models: AgentModelSettingsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Resolve management permission without revealing a private Bot's existence.
   *
   * `profiles.get` already applies visibility. A caller who cannot see the Bot therefore gets the
   * same 404 as an id that does not exist; a caller who may see a public Bot but does not own it gets
   * a 403, because at that point its existence is not secret.
   */
  const manageable = async (
    actor: AgentActor,
    agentId: string,
  ): Promise<"ok" | "missing" | "forbidden"> => {
    const profile = await profiles.get(actor, agentId);
    if (!profile) return "missing";
    return canManageAgentModel(actor, profile) ? "ok" : "forbidden";
  };

  routes.get("/:agentId/model", requireUser, async (context) => {
    const agentId = context.req.param("agentId").trim();
    if (!agentId) {
      return context.json({ error: "A Bot id is required." }, 400);
    }

    const access = await manageable(context.var.actor, agentId);
    if (access === "missing") {
      return context.json({ error: "Agent not found." }, 404);
    }
    if (access === "forbidden") {
      return context.json({ error: "Agent model settings cannot be managed by this actor." }, 403);
    }

    try {
      return context.json({ model: await models.get(agentId) });
    } catch (error) {
      if (error instanceof AgentModelNotFoundError) {
        // The profile can disappear between the authorization read and the model read. Preserve the
        // same public answer instead of turning that ordinary race into a 500.
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

    const access = await manageable(context.var.actor, agentId);
    if (access === "missing") {
      return context.json({ error: "Agent not found." }, 404);
    }
    if (access === "forbidden") {
      return context.json({ error: "Agent model settings cannot be managed by this actor." }, 403);
    }

    const parsed = parseAgentModelConfigInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }

    try {
      return context.json({ model: await models.save(agentId, parsed.value) });
    } catch (error) {
      if (error instanceof AgentModelNotFoundError) {
        return context.json({ error: "Agent not found." }, 404);
      }
      if (error instanceof AgentModelCredentialRequiredError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return routes;
}
