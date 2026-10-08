export const AGENT_INSTRUCTIONS_OVERRIDE_KEY = "instructions" as const;

/**
 * Per-Agent instructions are carried on every run of that coworker, so bound their prompt cost.
 *
 * Eight thousand characters is enough for a substantial operating brief without letting one
 * settings field quietly consume an unbounded part of every model context.
 */
export const AGENT_INSTRUCTIONS_LIMIT = 8_000;

export type AgentInstructionsInput = {
  instructions: string;
};

export type AgentInstructionsSettings = {
  /** Empty means this Agent has no deployment-owned instruction override. */
  instructions: string;
  /** Server-decided: owners/admins, plus admins for package-owned Agents. */
  canManage: boolean;
};

export type ParseAgentInstructionsResult =
  | { ok: true; value: AgentInstructionsInput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instructions = value.trim();
  if (
    instructions.length === 0 ||
    instructions.length > AGENT_INSTRUCTIONS_LIMIT ||
    instructions.includes("\u0000")
  ) {
    return null;
  }
  return instructions;
}

/** Validate the browser write before it reaches the Agent row. Empty text deliberately clears. */
export function parseAgentInstructionsInput(
  input: unknown,
): ParseAgentInstructionsResult {
  if (!isRecord(input) || typeof input.instructions !== "string") {
    return { ok: false, error: "Instructions must be text." };
  }
  const instructions = input.instructions.trim();
  if (instructions.length > AGENT_INSTRUCTIONS_LIMIT) {
    return {
      ok: false,
      error: `Agent instructions are at most ${AGENT_INSTRUCTIONS_LIMIT} characters.`,
    };
  }
  if (instructions.includes("\u0000")) {
    return {
      ok: false,
      error: "Agent instructions contain an unsupported character.",
    };
  }
  return { ok: true, value: { instructions } };
}

/** Read only this feature's namespace. Malformed persisted data fails closed to no override. */
export function storedAgentInstructionsFromOverride(
  override: unknown,
): string | null {
  if (!isRecord(override)) return null;
  return normalizedInstructions(override[AGENT_INSTRUCTIONS_OVERRIDE_KEY]);
}

/** Replace only this feature's namespace, preserving Model/API, Computer, and future overrides. */
export function withStoredAgentInstructions(
  override: unknown,
  instructions: string | null,
): Record<string, unknown> | null {
  const next = isRecord(override) ? { ...override } : {};
  const normalized = normalizedInstructions(instructions);
  if (normalized) next[AGENT_INSTRUCTIONS_OVERRIDE_KEY] = normalized;
  else delete next[AGENT_INSTRUCTIONS_OVERRIDE_KEY];
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Prompt block for one coworker's own deployment-level instructions.
 *
 * This sits after the immutable/package base role and before a person's global standing
 * preferences. It refines how this Agent works without turning a user preference into a new role.
 */
export function agentInstructionsGuidance(
  instructions: string | null | undefined,
): string | null {
  const normalized = normalizedInstructions(instructions);
  if (!normalized) return null;
  return [
    "Additional instructions configured specifically for this coworker:",
    normalized,
    "Follow these alongside the coworker's base role. If they conflict, the base role decides what the coworker is for and these instructions refine how it carries that role out.",
  ].join("\n\n");
}
