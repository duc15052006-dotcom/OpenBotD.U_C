import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createAgentModelConfigStore } from "../src/agents/model-config-store";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, credentials } from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 1 });
const vault = createCredentialStore(database);
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const suffix = randomUUID();
const agentId = `model-store-${suffix}`;
const actor: AgentActor = { id: `admin-${suffix}`, role: "admin" };

// The model store asks the profile boundary only whether the actor may manage this package-owned
// Bot. The persistence under test lives in agents.override and credentials, so a deliberately small
// profile fake keeps this file about the real database transaction rather than profile fixtures.
const profiles = {
  get: async (_actor: AgentActor, requestedId: string) =>
    requestedId === agentId
      ? { id: agentId, systemOwned: true, deletedAt: null }
      : null,
} as unknown as AgentProfileStore;

const store = createAgentModelConfigStore(database, profiles, {
  store: vault,
  reader: vault,
  encryptionKey,
});

beforeAll(async () => {
  await database.insert(agents).values({
    id: agentId,
    name: "Model Store Integration Bot",
    type: "built_in",
    configuration: { systemPrompt: "Test model persistence." },
    override: { computer: { internet: false } },
  });
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "model"),
        eq(credentials.keyId, `agent:${agentId}`),
      ),
    );
  await database.$client.end();
});

async function modelCredentialRows() {
  return database
    .select({
      id: credentials.id,
      encryptedValue: credentials.encryptedValue,
      revokedAt: credentials.revokedAt,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "model"),
        eq(credentials.keyId, `agent:${agentId}`),
      ),
    );
}

describe("per-Agent model settings in PostgreSQL", () => {
  test("stores, rotates, resolves, and revokes model credentials atomically", async () => {
    const publicConfig = await store.update(actor, agentId, {
      mode: "custom",
      provider: "openai",
      model: "gpt-primary",
      credentialSource: "custom",
      apiKey: "first-plaintext-key",
      temperature: 0.4,
      maxTokens: 2048,
      fallback: { provider: "anthropic", model: "claude-fallback" },
    });

    expect(publicConfig).toEqual({
      mode: "custom",
      provider: "openai",
      model: "gpt-primary",
      credentialSource: "custom",
      hasApiKey: true,
      temperature: 0.4,
      maxTokens: 2048,
      fallback: { provider: "anthropic", model: "claude-fallback" },
    });
    expect(JSON.stringify(publicConfig)).not.toContain("first-plaintext-key");

    const [configuredRow] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(configuredRow?.override).toMatchObject({
      computer: { internet: false },
      model: {
        provider: "openai",
        model: "gpt-primary",
        fallback: { provider: "anthropic", model: "claude-fallback" },
      },
    });
    expect(JSON.stringify(configuredRow?.override)).not.toContain(
      "first-plaintext-key",
    );

    const resolved = await store.resolve(agentId);
    expect(resolved).toMatchObject({
      provider: "openai",
      model: "gpt-primary",
      apiKey: "first-plaintext-key",
      fallback: { provider: "anthropic", model: "claude-fallback" },
    });

    const initialCredentials = await modelCredentialRows();
    expect(initialCredentials).toHaveLength(1);
    expect(initialCredentials[0]?.encryptedValue).not.toContain(
      "first-plaintext-key",
    );
    expect(initialCredentials[0]?.revokedAt).toBeNull();

    await store.update(actor, agentId, {
      mode: "custom",
      provider: "openai",
      model: "gpt-primary",
      credentialSource: "custom",
      apiKey: "second-plaintext-key",
      fallback: { provider: "openai", model: "gpt-fallback" },
    });

    expect((await store.resolve(agentId))?.apiKey).toBe("second-plaintext-key");
    const rotatedCredentials = await modelCredentialRows();
    expect(rotatedCredentials).toHaveLength(2);
    expect(
      rotatedCredentials.filter((row) => row.revokedAt === null),
    ).toHaveLength(1);

    expect(await store.update(actor, agentId, { mode: "global" })).toEqual({
      mode: "global",
    });
    expect(await store.resolve(agentId)).toBeNull();

    const [globalRow] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(globalRow?.override).toEqual({ computer: { internet: false } });

    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "model"),
          eq(credentials.keyId, `agent:${agentId}`),
          isNull(credentials.revokedAt),
        ),
      );
    expect(live).toEqual([]);
  });
});
