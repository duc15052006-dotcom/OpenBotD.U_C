import { describe, expect, test } from "bun:test";
import {
  createProviderApiKeyResolver,
  providerApiKeyFromEnvironment,
  resolveAgentRuntimeModel,
} from "../src/agents/runtime-model";

describe("resolveAgentRuntimeModel", () => {
  test("keeps the deployment model when the agent has no override", async () => {
    const result = await resolveAgentRuntimeModel({
      agentId: "researcher",
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: { resolve: async () => null },
      resolveProviderApiKey: async (provider) =>
        provider === "openai" ? "deployment-key" : null,
    });

    expect(result).toEqual({
      provider: "openai",
      defaultModel: "gpt-default",
      apiKey: "deployment-key",
    });
  });

  test("uses an agent's decrypted custom key without asking for a global one", async () => {
    const requested: string[] = [];
    const result = await resolveAgentRuntimeModel({
      agentId: "writer",
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolve: async () => ({
          provider: "anthropic",
          model: "claude-sonnet",
          apiKey: "agent-secret",
          temperature: 0.3,
        }),
      },
      resolveProviderApiKey: async (provider) => {
        requested.push(provider);
        return "global-secret";
      },
    });

    expect(result).toEqual({
      provider: "anthropic",
      defaultModel: "claude-sonnet",
      apiKey: "agent-secret",
      temperature: 0.3,
    });
    expect(requested).toEqual([]);
  });

  test("uses the selected provider's global credential when the override has no custom key", async () => {
    const result = await resolveAgentRuntimeModel({
      agentId: "researcher",
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolve: async () => ({
          provider: "google",
          model: "gemini-2.5-pro",
          apiKey: null,
          maxTokens: 4096,
        }),
      },
      resolveProviderApiKey: async (provider) =>
        provider === "google" ? "google-global" : null,
    });

    expect(result).toEqual({
      provider: "google",
      defaultModel: "gemini-2.5-pro",
      apiKey: "google-global",
      maxTokens: 4096,
    });
  });

  test("does not silently fall back to the deployment provider key", async () => {
    const result = await resolveAgentRuntimeModel({
      agentId: "writer",
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolve: async () => ({
          provider: "anthropic",
          model: "claude-sonnet",
          apiKey: null,
        }),
      },
      resolveProviderApiKey: async (provider) =>
        provider === "openai" ? "openai-key" : null,
    });

    expect(result.apiKey).toBeNull();
  });
});

describe("providerApiKeyFromEnvironment", () => {
  test("maps each provider to its own environment variable", () => {
    const environment = {
      OPENAI_API_KEY: " openai ",
      ANTHROPIC_API_KEY: " anthropic ",
      GOOGLE_API_KEY: " google ",
    };
    expect(providerApiKeyFromEnvironment("openai", environment)).toBe("openai");
    expect(providerApiKeyFromEnvironment("anthropic", environment)).toBe(
      "anthropic",
    );
    expect(providerApiKeyFromEnvironment("google", environment)).toBe("google");
  });

  test("blank keys are absent", () => {
    expect(
      providerApiKeyFromEnvironment("google", { GOOGLE_API_KEY: "   " }),
    ).toBeNull();
  });
});

describe("createProviderApiKeyResolver", () => {
  test("keeps the package provider on OpenBot's existing vault-aware resolver", async () => {
    let deploymentReads = 0;
    const resolve = createProviderApiKeyResolver({
      deploymentProvider: "openai",
      resolveDeploymentApiKey: async () => {
        deploymentReads += 1;
        return "rotated-vault-key";
      },
      environment: {
        OPENAI_API_KEY: "stale-env-key",
        ANTHROPIC_API_KEY: "anthropic-env-key",
      },
    });

    expect(await resolve("openai")).toBe("rotated-vault-key");
    expect(deploymentReads).toBe(1);
  });

  test("uses the selected provider environment fallback only for non-package providers", async () => {
    let deploymentReads = 0;
    const resolve = createProviderApiKeyResolver({
      deploymentProvider: "openai",
      resolveDeploymentApiKey: async () => {
        deploymentReads += 1;
        return "openai-vault-key";
      },
      environment: {
        ANTHROPIC_API_KEY: " anthropic-env-key ",
        GOOGLE_API_KEY: " google-env-key ",
      },
    });

    expect(await resolve("anthropic")).toBe("anthropic-env-key");
    expect(await resolve("google")).toBe("google-env-key");
    expect(deploymentReads).toBe(0);
  });
});
