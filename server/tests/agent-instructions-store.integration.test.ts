import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentInstructionsStore } from "../src/agents/instructions-store";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 1 });
const suffix = randomUUID();
const agentId = `instructions-${suffix}`;
const actor: AgentActor = { id: `admin-${suffix}`, role: "admin" };

const profiles = {
  get: async (_actor: AgentActor, requestedId: string) =>
    requestedId === agentId
      ? {
          id: agentId,
          systemOwned: true,
          deletedAt: null,
        }
      : null,
} as unknown as AgentProfileStore;

const store = createAgentInstructionsStore(database, profiles);

beforeAll(async () => {
  await database.insert(agents).values({
    id: agentId,
    name: "Instruction Store Integration Bot",
    type: "built_in",
    configuration: { systemPrompt: "Base role." },
    override: {
      model: { provider: "openai", model: "gpt-primary" },
      computer: { internet: false },
    },
  });
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
  await database.$client.end();
});

describe("per-Agent instructions in PostgreSQL", () => {
  test("writes and clears only its override namespace", async () => {
    const saved = await store.update(actor, agentId, {
      instructions: "  Verify sources before answering.  ",
    });

    expect(saved).toEqual({
      instructions: "Verify sources before answering.",
      canManage: true,
    });

    const [configured] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(configured?.override).toEqual({
      model: { provider: "openai", model: "gpt-primary" },
      computer: { internet: false },
      instructions: "Verify sources before answering.",
    });
    expect(await store.get(actor, agentId)).toEqual({
      instructions: "Verify sources before answering.",
      canManage: true,
    });

    await store.update(actor, agentId, { instructions: "" });

    const [cleared] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(cleared?.override).toEqual({
      model: { provider: "openai", model: "gpt-primary" },
      computer: { internet: false },
    });
  });
});
