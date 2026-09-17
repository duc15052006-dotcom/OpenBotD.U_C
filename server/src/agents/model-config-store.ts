import { eq } from "drizzle-orm";
import type { CredentialSecretReader, CredentialStore } from "../credentials";
import { decryptCredentialForUse, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import {
  type AgentModelConfigInput,
  type PublicAgentModelConfig,
  type StoredAgentModelConfig,
  publicAgentModelConfig,
  storedAgentModelConfigFromOverride,
  withStoredAgentModelConfig,
} from "./model-config";
import { canManageAgent } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
} from "./profile-store";
import type { AgentActor } from "./profile-types";

type ModelVault = {
  store: CredentialStore;
  reader: CredentialSecretReader;
  encryptionKey: string;
};

export type ResolvedAgentModelConfig = StoredAgentModelConfig & {
  apiKey: string | null;
};

export type AgentModelConfigStore = {
  get(actor: AgentActor, agentId: string): Promise<PublicAgentModelConfig>;
  update(
    actor: AgentActor,
    agentId: string,
    input: AgentModelConfigInput,
  ): Promise<PublicAgentModelConfig>;
  /** Runtime-only read. The caller has already established which Bot may run. */
  resolve(agentId: string): Promise<ResolvedAgentModelConfig | null>;
  /**
   * Management-only runtime read, for actions such as Test Connection that use a real credential.
   *
   * Kept separate from `resolve`: a run is authorised by the runtime's roster before this store is
   * asked, while a settings action starts with a person and must prove management permission here.
   */
  resolveManaged(
    actor: AgentActor,
    agentId: string,
  ): Promise<ResolvedAgentModelConfig | null>;
};

export class AgentModelCredentialRequiredError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} needs an API key for its custom model provider.`);
    this.name = "AgentModelCredentialRequiredError";
  }
}

function credentialKey(agentId: string) {
  return `agent:${agentId}`;
}

function canManageModel(
  actor: AgentActor,
  profile: Awaited<ReturnType<AgentProfileStore["get"]>>,
) {
  if (!profile) return false;
  // Package-owned agents intentionally cannot have their identity/profile edited, but their runtime
  // model is an administrator override. This exception is narrow to model configuration.
  if (profile.systemOwned) return actor.role === "admin";
  return canManageAgent(actor, profile);
}

function storedFromInput(
  input: Extract<AgentModelConfigInput, { mode: "custom" }>,
  credentialId?: string,
): StoredAgentModelConfig {
  return {
    provider: input.provider,
    model: input.model,
    ...(credentialId ? { credentialId } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.fallback ? { fallback: input.fallback } : {}),
  };
}

/**
 * Per-agent model settings live in `agents.override`; usable API keys live only in the encrypted
 * credential vault. Both mutations share the same database transaction so a provider/key change
 * cannot leave an active secret behind without the setting that owns it, or vice versa.
 */
export function createAgentModelConfigStore(
  database: Database,
  profiles: AgentProfileStore,
  vault: ModelVault,
): AgentModelConfigStore {
  async function readable(actor: AgentActor, agentId: string) {
    const profile = await profiles.get(actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    return profile;
  }

  async function manageable(actor: AgentActor, agentId: string) {
    const profile = await readable(actor, agentId);
    if (!canManageModel(actor, profile)) {
      throw new AgentNotManageableError(agentId);
    }
    return profile;
  }

  async function readStored(agentId: string) {
    const [row] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ? storedAgentModelConfigFromOverride(row.override) : null;
  }

  async function resolveStored(agentId: string) {
    const stored = await readStored(agentId);
    if (!stored) return null;
    const apiKey = stored.credentialId
      ? await decryptCredentialForUse(
          vault.encryptionKey,
          vault.reader,
          stored.credentialId,
        )
      : null;
    return { ...stored, apiKey };
  }

  return {
    async get(actor, agentId) {
      await readable(actor, agentId);
      const stored = await readStored(agentId);
      const hasApiKey = stored?.credentialId
        ? await vault.store.isLive(stored.credentialId)
        : false;
      return publicAgentModelConfig(stored, hasApiKey);
    },

    async update(actor, agentId, input) {
      await manageable(actor, agentId);

      const stored = await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ override: agents.override })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("update");
        if (!row) throw new AgentNotFoundError(agentId);

        const current = storedAgentModelConfigFromOverride(row.override);

        if (input.mode === "global") {
          if (
            current?.credentialId &&
            (await vault.store.isLive(current.credentialId, transaction))
          ) {
            await vault.store.revoke(current.credentialId, transaction);
          }
          await transaction
            .update(agents)
            .set({
              override: withStoredAgentModelConfig(row.override, null),
              updatedAt: new Date(),
            })
            .where(eq(agents.id, agentId));
          return null;
        }

        let credentialId: string | undefined;
        if (input.credentialSource === "custom") {
          const previousCredentialId = current?.credentialId;
          const providerChanged =
            current !== null && current.provider !== input.provider;

          if (input.apiKey) {
            const encryptedValue = await encryptSecret(
              vault.encryptionKey,
              input.apiKey,
            );
            if (previousCredentialId && !providerChanged) {
              const rotated = await vault.store.rotate(
                {
                  previousCredentialId,
                  kind: "model",
                  provider: input.provider,
                  keyId: credentialKey(agentId),
                  metadata: { agentId },
                  encryptedValue,
                },
                transaction,
              );
              credentialId = rotated.id;
            } else {
              if (
                previousCredentialId &&
                (await vault.store.isLive(previousCredentialId, transaction))
              ) {
                await vault.store.revoke(previousCredentialId, transaction);
              }
              const created = await vault.store.create(
                {
                  kind: "model",
                  provider: input.provider,
                  keyId: credentialKey(agentId),
                  metadata: { agentId },
                  encryptedValue,
                },
                transaction,
              );
              credentialId = created.id;
            }
          } else {
            if (!previousCredentialId || providerChanged) {
              throw new AgentModelCredentialRequiredError(agentId);
            }
            const live = await vault.store.isLive(
              previousCredentialId,
              transaction,
            );
            if (!live) throw new AgentModelCredentialRequiredError(agentId);
            credentialId = previousCredentialId;
          }
        } else if (
          current?.credentialId &&
          (await vault.store.isLive(current.credentialId, transaction))
        ) {
          await vault.store.revoke(current.credentialId, transaction);
        }

        const next = storedFromInput(input, credentialId);
        await transaction
          .update(agents)
          .set({
            override: withStoredAgentModelConfig(row.override, next),
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
        return next;
      });

      const hasApiKey = stored?.credentialId
        ? await vault.store.isLive(stored.credentialId)
        : false;
      return publicAgentModelConfig(stored, hasApiKey);
    },

    resolve: resolveStored,

    async resolveManaged(actor, agentId) {
      await manageable(actor, agentId);
      return resolveStored(agentId);
    },
  };
}
