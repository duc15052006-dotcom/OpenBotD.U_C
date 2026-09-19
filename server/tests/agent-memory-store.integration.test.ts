import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AgentMemoryConflictError,
  createAgentMemoryStore,
} from "../src/agents/memory-store";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 1 });
const suffix = randomUUID();
const agentId = `memory-${suffix}`;
const actor: AgentActor = { id: `admin-${suffix}`, role: "admin" };

const profiles = {
  get: async (_actor: AgentActor, requestedId: string) =>
    requestedId === agentId
      ? { id: agentId, systemOwned: true, deletedAt: null }
      : null,
} as unknown as AgentProfileStore;

const store = createAgentMemoryStore(database, profiles);

beforeAll(async () => {
  await database.insert(agents).values({
    id: agentId,
    name: "Memory Store Integration Bot",
    type: "built_in",
    configuration: { systemPrompt: "Base role." },
    override: { model: { provider: "openai", model: "gpt-primary" } },
  });
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
  await database.$client.end();
});

describe("per-Agent memory history in PostgreSQL", () => {
  test("detects stale writes and undo appends a new revision", async () => {
    const first = await store.update(actor, agentId, {
      memory: "First remembered fact.",
      baseRevisionId: null,
    });
    expect(first.revisionId).toBeString();

    const second = await store.update(actor, agentId, {
      memory: "Second remembered fact.",
      baseRevisionId: first.revisionId,
    });
    expect(second.revisionId).not.toBe(first.revisionId);

    await expect(
      store.update(actor, agentId, {
        memory: "Stale tab overwrite.",
        baseRevisionId: first.revisionId,
      }),
    ).rejects.toBeInstanceOf(AgentMemoryConflictError);

    const restored = await store.undo(actor, agentId, {
      revisionId: first.revisionId!,
      baseRevisionId: second.revisionId,
    });
    expect(restored.memory).toBe("First remembered fact.");
    expect(restored.revisionId).not.toBe(first.revisionId);

    const history = await store.history(actor, agentId);
    expect(history.revisions).toHaveLength(3);
    expect(history.revisions[0]).toMatchObject({
      id: restored.revisionId,
      kind: "undo",
      sourceRevisionId: first.revisionId,
    });

    const [row] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect((row?.override as { model?: unknown })?.model).toEqual({
      provider: "openai",
      model: "gpt-primary",
    });
  });
});
