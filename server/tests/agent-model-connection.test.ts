import { describe, expect, test } from "bun:test";
import {
  testAgentModelConnection,
  type ModelProbeFetch,
} from "../src/agents/model-connection";

function response(status: number) {
  return new Response("provider-detail-that-must-not-be-returned", { status });
}

describe("testAgentModelConnection", () => {
  test("does not make a request when no credential is available", async () => {
    let calls = 0;
    const fetcher: ModelProbeFetch = async () => {
      calls += 1;
      return response(200);
    };

    const result = await testAgentModelConnection(
      {
        provider: "openai",
        defaultModel: "gpt-5.6",
        apiKey: null,
      },
      fetcher,
    );

    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      provider: "openai",
      model: "gpt-5.6",
      code: "credential_missing",
      error: "No API key is available for this Agent and provider.",
    });
  });

  test("checks an OpenAI-compatible Base URL without generating tokens", async () => {
    let seen: { url: string; method?: string; headers: Headers } | undefined;
    const fetcher: ModelProbeFetch = async (url, init) => {
      seen = {
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
      };
      return response(200);
    };

    const result = await testAgentModelConnection(
      {
        provider: "openai",
        defaultModel: "vendor/model",
        apiKey: "openai-secret",
        baseUrl: "https://gateway.example/api/v1/",
      },
      fetcher,
    );

    expect(result).toEqual({
      ok: true,
      provider: "openai",
      model: "vendor/model",
    });
    expect(seen?.url).toBe(
      "https://gateway.example/api/v1/models/vendor%2Fmodel",
    );
    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("authorization")).toBe("Bearer openai-secret");
  });

  test("uses Anthropic model metadata and required headers", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetcher: ModelProbeFetch = async (url, init) => {
      seenUrl = url;
      seenHeaders = new Headers(init?.headers);
      return response(200);
    };

    const result = await testAgentModelConnection(
      {
        provider: "anthropic",
        defaultModel: "claude-sonnet-4.5",
        apiKey: "anthropic-secret",
      },
      fetcher,
    );

    expect(result.ok).toBe(true);
    expect(seenUrl).toBe(
      "https://api.anthropic.com/v1/models/claude-sonnet-4.5",
    );
    expect(seenHeaders.get("x-api-key")).toBe("anthropic-secret");
    expect(seenHeaders.get("anthropic-version")).toBe("2023-06-01");
  });

  test("normalizes Gemini's optional models/ prefix and uses the native API key header", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetcher: ModelProbeFetch = async (url, init) => {
      seenUrl = url;
      seenHeaders = new Headers(init?.headers);
      return response(200);
    };

    await testAgentModelConnection(
      {
        provider: "google",
        defaultModel: "models/gemini-2.5-pro",
        apiKey: "google-secret",
      },
      fetcher,
    );

    expect(seenUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro",
    );
    expect(seenHeaders.get("x-goog-api-key")).toBe("google-secret");
    expect(seenHeaders.get("authorization")).toBeNull();
  });

  test("classifies provider failures without returning the provider body", async () => {
    const result = await testAgentModelConnection(
      {
        provider: "openai",
        defaultModel: "gpt-5.6",
        apiKey: "bad-secret",
      },
      async () => response(401),
    );

    expect(result).toEqual({
      ok: false,
      provider: "openai",
      model: "gpt-5.6",
      code: "authentication_failed",
      error:
        "The provider rejected the API key or this account does not have access to the selected model.",
      status: 401,
    });
    expect(JSON.stringify(result)).not.toContain(
      "provider-detail-that-must-not-be-returned",
    );
    expect(JSON.stringify(result)).not.toContain("bad-secret");
  });

  test("does not reflect guarded-fetch or network details into the browser result", async () => {
    const result = await testAgentModelConnection(
      {
        provider: "openai",
        defaultModel: "custom",
        apiKey: "secret",
        baseUrl: "http://169.254.169.254/latest/meta-data",
      },
      async () => {
        throw new Error(
          "This deployment will not dial http://169.254.169.254/latest/meta-data",
        );
      },
    );

    expect(result).toEqual({
      ok: false,
      provider: "openai",
      model: "custom",
      code: "unreachable",
      error: "This deployment could not reach the model provider endpoint.",
    });
    expect(JSON.stringify(result)).not.toContain("169.254.169.254");
  });

  test("reports quota/rate limiting separately from an unreachable provider", async () => {
    const result = await testAgentModelConnection(
      {
        provider: "google",
        defaultModel: "gemini-2.5-pro",
        apiKey: "secret",
      },
      async () => response(429),
    );

    expect(result).toEqual({
      ok: false,
      provider: "google",
      model: "gemini-2.5-pro",
      code: "rate_limited",
      error:
        "The provider is reachable but this account is currently rate-limited or out of quota.",
      status: 429,
    });
  });
});
