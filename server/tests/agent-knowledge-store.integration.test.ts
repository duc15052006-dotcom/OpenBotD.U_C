import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentKnowledgeStore } from "../src/agents/knowledge-store";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 1 });
const suffix = randomUUID();
const agentId = `knowledge-${suffix}`;
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

const store = createAgentKnowledgeStore(database, profiles);

beforeAll(async () => {
  await database.insert(agents).values({
    id: agentId,
    name: "Knowledge Store Integration Bot",
    type: "built_in",
    configuration: { systemPrompt: "Base role." },
    override: {
      model: { provider: "openai", model: "gpt-primary" },
      instructions: "Keep answers concise.",
    },
  });
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
  await database.$client.end();
});

describe("Agent knowledge in PostgreSQL", () => {
  test("adds, lists and removes a file without changing other overrides", async () => {
    const added = await store.add(actor, agentId, {
      name: "policy.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("Refunds over $500 need manager approval."),
    });

    expect(added.documents).toHaveLength(1);
    expect(added.documents[0]).toMatchObject({
      name: "policy.txt",
      mimeType: "text/plain",
    });
    expect(added.documents[0]).not.toHaveProperty("content");

    const [configured] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(configured?.override).toMatchObject({
      model: { provider: "openai", model: "gpt-primary" },
      instructions: "Keep answers concise.",
    });

    const listed = await store.list(actor, agentId);
    expect(listed.documents).toEqual(added.documents);

    const documentId = added.documents[0]?.id;
    if (!documentId) throw new Error("Expected knowledge document id.");
    const removed = await store.remove(actor, agentId, documentId);
    expect(removed.documents).toEqual([]);

    const [cleared] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(cleared?.override).toEqual({
      model: { provider: "openai", model: "gpt-primary" },
      instructions: "Keep answers concise.",
    });
  });
});
