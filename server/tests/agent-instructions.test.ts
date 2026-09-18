import { describe, expect, test } from "bun:test";
import {
  AGENT_INSTRUCTIONS_LIMIT,
  agentInstructionsGuidance,
  parseAgentInstructionsInput,
  storedAgentInstructionsFromOverride,
  withStoredAgentInstructions,
} from "../src/agents/instructions";
import {
  builtInAgentConfiguration,
  registeredAgentFromRow,
  standingRoleMessage,
} from "../src/copilot";

describe("per-Agent instructions", () => {
  test("normalizes writes and accepts clearing", () => {
    expect(
      parseAgentInstructionsInput({ instructions: "  Cite primary sources.  " }),
    ).toEqual({
      ok: true,
      value: { instructions: "Cite primary sources." },
    });
    expect(parseAgentInstructionsInput({ instructions: "   " })).toEqual({
      ok: true,
      value: { instructions: "" },
    });
  });

  test("bounds prompt cost and refuses unsupported data", () => {
    expect(
      parseAgentInstructionsInput({
        instructions: "x".repeat(AGENT_INSTRUCTIONS_LIMIT + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Agent instructions are at most ${AGENT_INSTRUCTIONS_LIMIT} characters.`,
    });
    expect(
      parseAgentInstructionsInput({ instructions: "bad\u0000instruction" }),
    ).toEqual({
      ok: false,
      error: "Agent instructions contain an unsupported character.",
    });
    expect(parseAgentInstructionsInput({ instructions: 42 })).toEqual({
      ok: false,
      error: "Instructions must be text.",
    });
  });

  test("stores only its override namespace and preserves unrelated settings", () => {
    const original = {
      model: { provider: "openai", model: "gpt-5" },
      computer: { internet: false },
    };

    const configured = withStoredAgentInstructions(
      original,
      "Always verify file contents before answering.",
    );
    expect(configured).toEqual({
      ...original,
      instructions: "Always verify file contents before answering.",
    });
    expect(storedAgentInstructionsFromOverride(configured)).toBe(
      "Always verify file contents before answering.",
    );

    expect(withStoredAgentInstructions(configured, null)).toEqual(original);
    expect(original).toEqual({
      model: { provider: "openai", model: "gpt-5" },
      computer: { internet: false },
    });
  });

  test("adds one bounded instruction block to a built-in Agent prompt", () => {
    const configuration = builtInAgentConfiguration(
      {
        id: "writer",
        name: "Writer",
        type: "built_in",
        systemPrompt: "Write accurate reports.",
        instructions: "Use concise headings and cite every factual claim.",
      },
      { provider: "openai", defaultModel: "gpt-test" },
      "test-key",
    ) as { prompt?: string };

    expect(configuration.prompt).toContain("Write accurate reports.");
    expect(configuration.prompt).toContain(
      "Additional instructions configured specifically for this coworker:",
    );
    expect(configuration.prompt).toContain(
      "Use concise headings and cite every factual claim.",
    );
  });

  test("loads the same Agent instructions into remote standing role messages", () => {
    const registered = registeredAgentFromRow({
      id: "researcher",
      name: "Researcher",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://agent.example.test/ag-ui" },
      override: { instructions: "Prefer primary sources." },
      title: "Research",
      roleDescription: "Investigate questions and report evidence.",
    });

    expect(registered).toMatchObject({
      id: "researcher",
      type: "remote_ag_ui",
    });
    expect(
      (registered as { standingMessage?: { content?: string } })
        .standingMessage?.content,
    ).toContain("Prefer primary sources.");
  });

  test("leaves remote role behavior unchanged when no override exists", () => {
    const message = standingRoleMessage({
      id: "risk",
      name: "Risk",
      title: "Compliance",
      roleDescription: "Investigate controls.",
    });

    expect(message.content).toContain("Investigate controls.");
    expect(message.content).not.toContain(
      "Additional instructions configured specifically for this coworker:",
    );
  });

  test("malformed persisted overrides fail closed", () => {
    expect(
      storedAgentInstructionsFromOverride({
        instructions: "x".repeat(AGENT_INSTRUCTIONS_LIMIT + 1),
      }),
    ).toBeNull();
    expect(storedAgentInstructionsFromOverride({ instructions: 7 })).toBeNull();
    expect(agentInstructionsGuidance("   ")).toBeNull();
  });
});
