import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import {
  AGENT_MEMORY_HISTORY_LIMIT,
  type AgentMemoryHistory,
  type AgentMemoryInput,
  type AgentMemorySettings,
  type AgentMemoryUndoInput,
  diffMemoryLines,
  memoryHistoryEntry,
  storedAgentMemoryFromOverride,
  withStoredAgentMemory,
} from "./memory";
import { canManageAgentRuntimeSettings } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
} from "./profile-store";
import type { AgentActor } from "./profile-types";

export class AgentMemoryConflictError extends Error {
  constructor() {
    super("Agent memory changed since this screen loaded.");
    this.name = "AgentMemoryConflictError";
  }
}
export class AgentMemoryRevisionNotFoundError extends Error {
  constructor() {
    super("That memory revision is no longer available.");
    this.name = "AgentMemoryRevisionNotFoundError";
  }
}

export type AgentMemoryStore = {
  get(actor: AgentActor, agentId: string): Promise<AgentMemorySettings>;
  history(actor: AgentActor, agentId: string): Promise<AgentMemoryHistory>;
  diff(actor: AgentActor, agentId: string, revisionId: string): Promise<{
    revision: ReturnType<typeof memoryHistoryEntry>;
    lines: ReturnType<typeof diffMemoryLines>;
  }>;
  update(actor: AgentActor, agentId: string, input: AgentMemoryInput): Promise<AgentMemorySettings>;
  undo(actor: AgentActor, agentId: string, input: AgentMemoryUndoInput): Promise<AgentMemorySettings>;
};

export function createAgentMemoryStore(database: Database, profiles: AgentProfileStore): AgentMemoryStore {
  async function readable(actor: AgentActor, agentId: string) {
    const profile = await profiles.get(actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    return profile;
  }
  async function manageable(actor: AgentActor, agentId: string) {
    const profile = await readable(actor, agentId);
    if (!canManageAgentRuntimeSettings(actor, profile)) throw new AgentNotManageableError(agentId);
    return profile;
  }
  async function current(agentId: string) {
    const [row] = await database.select({ override: agents.override }).from(agents).where(eq(agents.id, agentId));
    if (!row) throw new AgentNotFoundError(agentId);
    return storedAgentMemoryFromOverride(row.override);
  }
  function settings(memory: ReturnType<typeof storedAgentMemoryFromOverride>, canManage: boolean): AgentMemorySettings {
    return { memory: memory.current, revisionId: memory.revisionId, canManage };
  }

  return {
    async get(actor, agentId) {
      const profile = await readable(actor, agentId);
      return settings(await current(agentId), canManageAgentRuntimeSettings(actor, profile));
    },
    async history(actor, agentId) {
      const profile = await readable(actor, agentId);
      const memory = await current(agentId);
      return {
        revisions: memory.revisions.map(memoryHistoryEntry),
        canManage: canManageAgentRuntimeSettings(actor, profile),
      };
    },
    async diff(actor, agentId, revisionId) {
      await readable(actor, agentId);
      const memory = await current(agentId);
      const revision = memory.revisions.find((one) => one.id === revisionId);
      if (!revision) throw new AgentMemoryRevisionNotFoundError();
      return {
        revision: memoryHistoryEntry(revision),
        lines: diffMemoryLines(revision.memory, memory.current),
      };
    },
    async update(actor, agentId, input) {
      await manageable(actor, agentId);
      let saved = null as ReturnType<typeof storedAgentMemoryFromOverride> | null;
      await database.transaction(async (transaction) => {
        const [row] = await transaction.select({ override: agents.override }).from(agents).where(eq(agents.id, agentId)).for("update");
        if (!row) throw new AgentNotFoundError(agentId);
        const before = storedAgentMemoryFromOverride(row.override);
        if (before.revisionId !== input.baseRevisionId) throw new AgentMemoryConflictError();
        if (before.current === input.memory) {
          saved = before;
          return;
        }
        const revision = {
          id: crypto.randomUUID(),
          memory: input.memory,
          createdAt: new Date().toISOString(),
          kind: "edit" as const,
        };
        saved = {
          current: input.memory,
          revisionId: revision.id,
          revisions: [revision, ...before.revisions].slice(0, AGENT_MEMORY_HISTORY_LIMIT),
        };
        await transaction.update(agents).set({
          override: withStoredAgentMemory(row.override, saved),
          updatedAt: new Date(),
        }).where(eq(agents.id, agentId));
      });
      return settings(saved!, true);
    },
    async undo(actor, agentId, input) {
      await manageable(actor, agentId);
      let saved = null as ReturnType<typeof storedAgentMemoryFromOverride> | null;
      await database.transaction(async (transaction) => {
        const [row] = await transaction.select({ override: agents.override }).from(agents).where(eq(agents.id, agentId)).for("update");
        if (!row) throw new AgentNotFoundError(agentId);
        const before = storedAgentMemoryFromOverride(row.override);
        if (before.revisionId !== input.baseRevisionId) throw new AgentMemoryConflictError();
        const target = before.revisions.find((one) => one.id === input.revisionId);
        if (!target) throw new AgentMemoryRevisionNotFoundError();
        if (target.id === before.revisionId) {
          saved = before;
          return;
        }
        const revision = {
          id: crypto.randomUUID(),
          memory: target.memory,
          createdAt: new Date().toISOString(),
          kind: "undo" as const,
          sourceRevisionId: target.id,
        };
        saved = {
          current: target.memory,
          revisionId: revision.id,
          revisions: [revision, ...before.revisions].slice(0, AGENT_MEMORY_HISTORY_LIMIT),
        };
        await transaction.update(agents).set({
          override: withStoredAgentMemory(row.override, saved),
          updatedAt: new Date(),
        }).where(eq(agents.id, agentId));
      });
      return settings(saved!, true);
    },
  };
}
