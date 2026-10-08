import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import {
  type AgentInstructionsInput,
  type AgentInstructionsSettings,
  storedAgentInstructionsFromOverride,
  withStoredAgentInstructions,
} from "./instructions";
import { canManageAgentRuntimeSettings } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
} from "./profile-store";
import type { AgentActor } from "./profile-types";

export type AgentInstructionsStore = {
  get(actor: AgentActor, agentId: string): Promise<AgentInstructionsSettings>;
  update(
    actor: AgentActor,
    agentId: string,
    input: AgentInstructionsInput,
  ): Promise<AgentInstructionsSettings>;
};

export function createAgentInstructionsStore(
  database: Database,
  profiles: AgentProfileStore,
): AgentInstructionsStore {
  async function readable(actor: AgentActor, agentId: string) {
    const profile = await profiles.get(actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    return profile;
  }

  async function readStored(agentId: string) {
    const [row] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ? storedAgentInstructionsFromOverride(row.override) : null;
  }

  return {
    async get(actor, agentId) {
      const profile = await readable(actor, agentId);
      return {
        instructions: (await readStored(agentId)) ?? "",
        canManage: canManageAgentRuntimeSettings(actor, profile),
      };
    },

    async update(actor, agentId, input) {
      const profile = await readable(actor, agentId);
      if (!canManageAgentRuntimeSettings(actor, profile)) {
        throw new AgentNotManageableError(agentId);
      }

      const instructions = input.instructions.trim();
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ override: agents.override })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("update");
        if (!row) throw new AgentNotFoundError(agentId);

        await transaction
          .update(agents)
          .set({
            override: withStoredAgentInstructions(
              row.override,
              instructions || null,
            ),
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
      });

      return { instructions, canManage: true };
    },
  };
}
