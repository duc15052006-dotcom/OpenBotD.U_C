export const AGENT_MODEL_PROVIDERS = ["openai", "anthropic", "google"] as const;

export type AgentModelProvider = (typeof AGENT_MODEL_PROVIDERS)[number];
export type AgentModelCredentialSource = "deployment" | "custom";

/**
 * The non-secret model settings stored beside an agent's runtime configuration.
 *
 * The API key never belongs here. `credentialId` is only a pointer into OpenBot's encrypted
 * credential vault; a database dump of the agents table must not become a list of working keys.
 */
export type StoredAgentModelConfig = {
  provider: AgentModelProvider;
  model: string;
  credentialId?: string;
};

/** What a browser may read. The credential is intentionally reduced to a boolean. */
export type AgentModelConfig = {
  provider: AgentModelProvider;
  model: string;
  credentialSource: AgentModelCredentialSource;
  hasApiKey: boolean;
};

export type AgentModelConfigInput = {
  provider: AgentModelProvider;
  model: string;
  credentialSource: AgentModelCredentialSource;
  /** Write-only. An omitted value preserves an existing custom key. */
  apiKey?: string;
};

export type ParseAgentModelConfigResult =
  | { ok: true; value: AgentModelConfigInput }
  | { ok: false; error: string };

/**
 * A deliberately namespaced key inside `agents.configuration`.
 *
 * Agent runtime configuration predates this feature and already carries endpoint/auth/systemPrompt
 * fields. A namespaced object keeps this addition from colliding with transport-specific fields and
 * lets existing spread-based profile edits preserve it unchanged.
 */
export const AGENT_MODEL_CONFIG_KEY = "openbotModel" as const;

const MAX_MODEL_LENGTH = 160;
const MAX_API_KEY_LENGTH = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is AgentModelProvider {
  return (
    typeof value === "string" &&
    (AGENT_MODEL_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Validate the user-controlled model selector before it reaches CopilotKit.
 *
 * Provider and model are separate on purpose. Concatenating an arbitrary string from the browser
 * directly into `provider/model` would let malformed identifiers reach the runtime and turn a form
 * error into a failed agent run.
 */
export function parseAgentModelConfigInput(
  input: unknown,
): ParseAgentModelConfigResult {
  if (!isRecord(input)) {
    return { ok: false, error: "Model settings must be a JSON object." };
  }

  if (!isProvider(input.provider)) {
    return {
      ok: false,
      error: "Provider must be openai, anthropic, or google.",
    };
  }

  if (typeof input.model !== "string") {
    return { ok: false, error: "Model must be text." };
  }
  const model = input.model.trim();
  if (!model || model.length > MAX_MODEL_LENGTH || /[\r\n]/.test(model)) {
    return {
      ok: false,
      error: `Model must be between 1 and ${MAX_MODEL_LENGTH} characters on one line.`,
    };
  }

  if (
    input.credentialSource !== "deployment" &&
    input.credentialSource !== "custom"
  ) {
    return {
      ok: false,
      error: "Credential source must be deployment or custom.",
    };
  }

  let apiKey: string | undefined;
  if (input.apiKey !== undefined && input.apiKey !== null) {
    if (typeof input.apiKey !== "string") {
      return { ok: false, error: "API key must be text." };
    }
    const trimmed = input.apiKey.trim();
    if (trimmed.length > MAX_API_KEY_LENGTH) {
      return {
        ok: false,
        error: `API key must be at most ${MAX_API_KEY_LENGTH} characters.`,
      };
    }
    if (/[\u0000\r\n]/.test(trimmed)) {
      return { ok: false, error: "API key contains an unsupported character." };
    }
    if (trimmed) apiKey = trimmed;
  }

  // A deployment credential ignores any key the browser happened to leave in the form. Dropping it
  // here makes it impossible for a hidden/stale input to rotate a vault secret while the screen says
  // the agent uses the deployment credential.
  return {
    ok: true,
    value: {
      provider: input.provider,
      model,
      credentialSource: input.credentialSource,
      ...(input.credentialSource === "custom" && apiKey ? { apiKey } : {}),
    },
  };
}

/** Read the non-secret settings out of an agent row. Malformed historical data fails closed. */
export function storedAgentModelConfig(
  configuration: unknown,
): StoredAgentModelConfig | null {
  if (!isRecord(configuration)) return null;
  const raw = configuration[AGENT_MODEL_CONFIG_KEY];
  if (!isRecord(raw) || !isProvider(raw.provider)) return null;
  if (typeof raw.model !== "string") return null;
  const model = raw.model.trim();
  if (!model || model.length > MAX_MODEL_LENGTH || /[\r\n]/.test(model)) {
    return null;
  }

  const credentialId =
    typeof raw.credentialId === "string" && raw.credentialId.trim()
      ? raw.credentialId.trim()
      : undefined;

  return {
    provider: raw.provider,
    model,
    ...(credentialId ? { credentialId } : {}),
  };
}

/**
 * Replace only OpenBot's model namespace while preserving endpoint, prompt and future fields.
 * Passing null removes the override and returns the agent to deployment defaults.
 */
export function withStoredAgentModelConfig(
  configuration: unknown,
  modelConfig: StoredAgentModelConfig | null,
): Record<string, unknown> {
  const next = isRecord(configuration) ? { ...configuration } : {};
  if (modelConfig) {
    next[AGENT_MODEL_CONFIG_KEY] = modelConfig;
  } else {
    delete next[AGENT_MODEL_CONFIG_KEY];
  }
  return next;
}

/** The model identifier format accepted by CopilotKit runtime v2. */
export function agentModelSpecifier(config: {
  provider: AgentModelProvider;
  model: string;
}): string {
  return `${config.provider}/${config.model}`;
}

export function publicAgentModelConfig(
  stored: StoredAgentModelConfig,
  hasApiKey: boolean,
): AgentModelConfig {
  return {
    provider: stored.provider,
    model: stored.model,
    credentialSource: stored.credentialId ? "custom" : "deployment",
    hasApiKey: stored.credentialId ? hasApiKey : false,
  };
}
