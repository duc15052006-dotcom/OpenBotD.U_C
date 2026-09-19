import type { AgentActor, AgentProfile } from "./profile-types";

export function canAccessAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  return (
    agent.visibility === "public" ||
    agent.ownerUserId === actor.id ||
    actor.role === "admin"
  );
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id || actor.role === "admin";
}

/**
 * Management rule for deployment-owned runtime overrides such as Model/API and Instructions.
 *
 * Package-owned Agents keep their identity immutable, but an administrator still needs to tune
 * how this deployment runs them. User-owned Agents keep the ordinary owner/admin profile rule.
 */
export function canManageAgentRuntimeSettings(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;
  if (agent.systemOwned) return actor.role === "admin";
  return canManageAgent(actor, agent);
}

export const canRunAgent = canAccessAgent;

/**
 * Whether this person may act as this Bot.
 *
 * Injected rather than imported, so a surface that acts as a Bot depends on the question and not on
 * the agents table. It also keeps the answer in one place: the store's read path already filters on
 * {@link canAccessAgent}, so asking it is the same rule the roster and the runtime already apply,
 * rather than a second copy that can drift from them.
 */
export type BotAccessCheck = (
  /** The whole actor, not just the id: an administrator reaches every Bot, and a role tells us. */
  actor: AgentActor,
  botId: string,
) => Promise<boolean>;
