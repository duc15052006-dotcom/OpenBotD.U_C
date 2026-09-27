import { describe, expect, test } from "bun:test";
import { createAgentModelConnectionService } from "../src/agents/model-connection-service";
import { AgentNotManageableError } from "../src/agents/profile-store";

const OWNER = { id: "owner", role: "user" as const };

describe("createAgentModelConnectionService", () => {
  test("uses the management-authorized resolver before decrypting or probing", async () => {
    let fetchCalls = 0;
    const service = createAgentModelConnectionService({
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolveManaged: async () => {
          throw new AgentNotManageableError("shared-agent");
        },
      },
      resolveProviderApiKey: async () => "deployment-key",
      guardedFetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(service.test(OWNER, "shared-agent")).rejects.toBeInstanceOf(
      AgentNotManageableError,
    );
    expect(fetchCalls).toBe(0);
  });

  test("tests a custom Agent key without consulting the global provider key", async () => {
    const requestedProviders: string[] = [];
    let authorization: string | null = null;
    const service = createAgentModelConnectionService({
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolveManaged: async (actor, id) => {
          expect(actor).toEqual(OWNER);
          expect(id).toBe("writer");
          return {
            provider: "openai",
            model: "gpt-custom",
            apiKey: "agent-key",
          };
        },
      },
      resolveProviderApiKey: async (provider) => {
        requestedProviders.push(provider);
        return "global-key";
      },
      guardedFetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: 200 });
      },
    });

    expect(await service.test(OWNER, "writer")).toEqual({
      ok: true,
      provider: "openai",
      model: "gpt-custom",
    });
    expect(authorization).toBe("Bearer agent-key");
    expect(requestedProviders).toEqual([]);
  });

  test("uses the selected provider's global key for a global-credential override", async () => {
    const requestedProviders: string[] = [];
    let apiKeyHeader: string | null = null;
    const service = createAgentModelConnectionService({
      deployment: { provider: "openai", defaultModel: "gpt-default" },
      modelConfigs: {
        resolveManaged: async () => ({
          provider: "anthropic",
          model: "claude-sonnet-4.5",
          apiKey: null,
        }),
      },
      resolveProviderApiKey: async (provider) => {
        requestedProviders.push(provider);
        return provider === "anthropic" ? "anthropic-global" : null;
      },
      guardedFetch: async (_url, init) => {
        apiKeyHeader = new Headers(init?.headers).get("x-api-key");
        return new Response(null, { status: 200 });
      },
    });

    expect(await service.test(OWNER, "writer")).toEqual({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-4.5",
    });
    expect(requestedProviders).toEqual(["anthropic"]);
    expect(apiKeyHeader).toBe("anthropic-global");
  });
});
