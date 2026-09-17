import { describe, expect, test } from "bun:test";
import {
  agentModelSpecifier,
  parseAgentModelConfigInput,
  publicAgentModelConfig,
} from "../src/agents/model-config";

describe("parseAgentModelConfigInput", () => {
  test("global mode ignores stale custom fields and never carries a key", () => {
    expect(
      parseAgentModelConfigInput({
        mode: "global",
        provider: "openai",
        model: "stale-model",
        apiKey: "must-not-survive",
      }),
    ).toEqual({ ok: true, value: { mode: "global" } });
  });

  test("normalizes a custom OpenAI-compatible configuration", () => {
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "openai",
        model: "  gpt-5.6  ",
        credentialSource: "custom",
        apiKey: "  secret-value  ",
        baseUrl: "https://gateway.example/v1",
        temperature: 0.7,
        maxTokens: 8192,
        fallback: { provider: "anthropic", model: "claude-sonnet" },
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: "custom",
        provider: "openai",
        model: "gpt-5.6",
        credentialSource: "custom",
        apiKey: "secret-value",
        baseUrl: "https://gateway.example/v1",
        temperature: 0.7,
        maxTokens: 8192,
        fallback: { provider: "anthropic", model: "claude-sonnet" },
      },
    });
  });

  test("blank API key means preserve the existing custom secret", () => {
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "google",
        model: "gemini-2.5-pro",
        credentialSource: "custom",
        apiKey: "   ",
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: "custom",
        provider: "google",
        model: "gemini-2.5-pro",
        credentialSource: "custom",
      },
    });
  });

  test("does not accept a custom base URL for native Anthropic or Google providers", () => {
    const result = parseAgentModelConfigInput({
      mode: "custom",
      provider: "anthropic",
      model: "claude-sonnet",
      credentialSource: "global",
      baseUrl: "https://proxy.example/v1",
    });
    expect(result).toEqual({
      ok: false,
      error: "Base URL is currently supported only for OpenAI-compatible models.",
    });
  });

  test("rejects credentials embedded in a base URL", () => {
    const result = parseAgentModelConfigInput({
      mode: "custom",
      provider: "openai",
      model: "gpt-5.6",
      credentialSource: "global",
      baseUrl: "https://user:password@gateway.example/v1",
    });
    expect(result).toEqual({
      ok: false,
      error: "Base URL must not contain credentials.",
    });
  });

  test("rejects invalid sampling and token limits before runtime", () => {
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "openai",
        model: "gpt-5.6",
        credentialSource: "global",
        temperature: 2.1,
      }).ok,
    ).toBe(false);
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "openai",
        model: "gpt-5.6",
        credentialSource: "global",
        maxTokens: 1.5,
      }).ok,
    ).toBe(false);
  });

  test("rejects multiline model and API-key values", () => {
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "openai",
        model: "gpt\nother",
        credentialSource: "global",
      }).ok,
    ).toBe(false);
    expect(
      parseAgentModelConfigInput({
        mode: "custom",
        provider: "openai",
        model: "gpt-5.6",
        credentialSource: "custom",
        apiKey: "secret\nheader",
      }).ok,
    ).toBe(false);
  });
});

describe("publicAgentModelConfig", () => {
  test("global mode has no secret state", () => {
    expect(publicAgentModelConfig(null, true)).toEqual({ mode: "global" });
  });

  test("never exposes the credential id", () => {
    const result = publicAgentModelConfig(
      {
        provider: "openai",
        model: "gpt-5.6",
        credentialId: "credential-secret-pointer",
        temperature: 0.4,
      },
      true,
    );
    expect(result).toEqual({
      mode: "custom",
      provider: "openai",
      model: "gpt-5.6",
      temperature: 0.4,
      hasApiKey: true,
    });
    expect("credentialId" in result).toBe(false);
  });
});

test("agentModelSpecifier uses CopilotKit's provider/model form", () => {
  expect(agentModelSpecifier({ provider: "google", model: "gemini-2.5-pro" })).toBe(
    "google/gemini-2.5-pro",
  );
});
