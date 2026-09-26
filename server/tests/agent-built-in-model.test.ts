import { describe, expect, test } from "bun:test";
import {
  AgentModelBaseUrlUnavailableError,
  builtInModelConfiguration,
} from "../src/agents/built-in-model";

describe("builtInModelConfiguration", () => {
  test("returns null rather than letting CopilotKit silently choose an environment key", () => {
    expect(
      builtInModelConfiguration({
        provider: "google",
        defaultModel: "gemini-2.5-pro",
        apiKey: null,
      }),
    ).toBeNull();
  });

  test("maps a native provider to CopilotKit v2 sampling fields", () => {
    expect(
      builtInModelConfiguration({
        provider: "anthropic",
        defaultModel: "claude-sonnet-4.5",
        apiKey: "anthropic-secret",
        temperature: 0.35,
        maxTokens: 8192,
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      apiKey: "anthropic-secret",
      temperature: 0.35,
      maxOutputTokens: 8192,
    });
  });

  test("does not silently ignore a configured OpenAI-compatible Base URL", () => {
    expect(() =>
      builtInModelConfiguration({
        provider: "openai",
        defaultModel: "custom-model",
        apiKey: "proxy-secret",
        baseUrl: "https://proxy.example/v1",
      }),
    ).toThrow(AgentModelBaseUrlUnavailableError);
  });

  test("uses an injected compatible provider model and does not duplicate its API key", () => {
    const seen: Array<{ baseUrl: string; apiKey: string; model: string }> = [];
    const result = builtInModelConfiguration(
      {
        provider: "openai",
        defaultModel: "custom-model",
        apiKey: "proxy-secret",
        baseUrl: "https://proxy.example/v1",
        maxTokens: 2048,
      },
      (input) => {
        seen.push(input);
        return "openai/custom-model";
      },
    );

    expect(seen).toEqual([
      {
        baseUrl: "https://proxy.example/v1",
        apiKey: "proxy-secret",
        model: "custom-model",
      },
    ]);
    expect(result).toEqual({
      model: "openai/custom-model",
      maxOutputTokens: 2048,
    });
    expect(result && "apiKey" in result).toBe(false);
  });
});
