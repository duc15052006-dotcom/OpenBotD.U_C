import type { AgentModelProvider, AgentModelTarget } from "./model-config";
import type { AgentModelConfigStore } from "./model-config-store";

export type RuntimeAgentModel = {
  provider: AgentModelProvider;
  defaultModel: string;
  apiKey: string | null;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  fallback?: AgentModelTarget;
};

export type DeploymentRuntimeModel = {
  provider: AgentModelProvider;
  defaultModel: string;
};

export type ResolveProviderApiKey = (
  provider: AgentModelProvider,
) => Promise<string | null>;

/**
 * Resolve one built-in Agent's model immediately before it is built.
 *
 * No override means the deployment model exactly as before this feature. A custom override may use
 * its own encrypted vault credential; without one it intentionally asks the deployment/global key
 * resolver for that provider. The resolver is injected so this module never reads process.env and
 * never needs to know where deployment credentials came from.
 */
export async function resolveAgentRuntimeModel(input: {
  agentId: string;
  deployment: DeploymentRuntimeModel;
  modelConfigs: Pick<AgentModelConfigStore, "resolve">;
  resolveProviderApiKey: ResolveProviderApiKey;
}): Promise<RuntimeAgentModel> {
  const custom = await input.modelConfigs.resolve(input.agentId);
  if (!custom) {
    return {
      ...input.deployment,
      apiKey: await input.resolveProviderApiKey(input.deployment.provider),
    };
  }

  const apiKey =
    custom.apiKey ?? (await input.resolveProviderApiKey(custom.provider));
  return {
    provider: custom.provider,
    defaultModel: custom.model,
    apiKey,
    ...(custom.baseUrl ? { baseUrl: custom.baseUrl } : {}),
    ...(custom.temperature !== undefined
      ? { temperature: custom.temperature }
      : {}),
    ...(custom.maxTokens !== undefined ? { maxTokens: custom.maxTokens } : {}),
    ...(custom.fallback ? { fallback: custom.fallback } : {}),
  };
}

/** Environment fallback names used when an Agent selects a provider other than the package default. */
export function providerApiKeyFromEnvironment(
  provider: AgentModelProvider,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const name =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "GOOGLE_API_KEY";
  const value = environment[name]?.trim();
  return value || null;
}

/**
 * Preserve OpenBot's existing deployment credential path while allowing an Agent to select another
 * native provider.
 *
 * The package's provider may point at a credentialSecretRef in the encrypted vault, and the existing
 * resolver also observes a rotation without restarting the server. Replacing that path with a raw
 * environment lookup would silently break both behaviours. Providers introduced only by an Agent
 * have no package secret reference, so they intentionally use their standard environment fallback.
 */
export function createProviderApiKeyResolver(input: {
  deploymentProvider: AgentModelProvider;
  resolveDeploymentApiKey: () => Promise<string | null>;
  environment?: Record<string, string | undefined>;
}): ResolveProviderApiKey {
  return async (provider) =>
    provider === input.deploymentProvider
      ? input.resolveDeploymentApiKey()
      : providerApiKeyFromEnvironment(provider, input.environment);
}
