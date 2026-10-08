export const AGENT_MODEL_PROVIDERS = ["openai", "anthropic", "google"] as const;

export type AgentModelProvider = (typeof AGENT_MODEL_PROVIDERS)[number];
export type AgentModelMode = "global" | "custom";
export type AgentModelCredentialSource = "global" | "custom";

export type AgentModelTarget = {
  provider: AgentModelProvider;
  model: string;
};

/**
 * Non-secret settings persisted for one built-in agent.
 *
 * Secrets are deliberately represented only by credential ids. The credential row itself is owned
 * by OpenBot's encrypted vault, so neither this type nor the agent row ever contains a usable key.
 */
export type StoredAgentModelConfig = {
  provider: AgentModelProvider;
  model: string;
  credentialId?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  fallback?: AgentModelTarget;
};

/** Safe model settings returned to the browser. Never contains credential material. */
export type PublicAgentModelConfig =
  | { mode: "global" }
  | ({
      mode: "custom";
      credentialSource: AgentModelCredentialSource;
      hasApiKey: boolean;
    } & Omit<StoredAgentModelConfig, "credentialId">);

/**
 * Browser input for model settings. `apiKey` is write-only; an omitted/blank value means preserve
 * the current custom key rather than accidentally deleting it while editing another field.
 */
export type AgentModelConfigInput =
  | { mode: "global" }
  | ({
      mode: "custom";
      credentialSource: AgentModelCredentialSource;
      apiKey?: string;
    } & Omit<StoredAgentModelConfig, "credentialId">);

export type ParseAgentModelConfigResult =
  | { ok: true; value: AgentModelConfigInput }
  | { ok: false; error: string };

/** Namespace inside `agents.override`; tenant package sync deliberately leaves this column alone. */
export const AGENT_MODEL_OVERRIDE_KEY = "model" as const;

const MAX_MODEL_LENGTH = 160;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_BASE_URL_LENGTH = 2_048;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsUnsupportedControl(value: string): boolean {
  return (
    value.includes("\u0000") || value.includes("\r") || value.includes("\n")
  );
}

function isProvider(value: unknown): value is AgentModelProvider {
  return (
    typeof value === "string" &&
    (AGENT_MODEL_PROVIDERS as readonly string[]).includes(value)
  );
}

function modelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_MODEL_LENGTH ||
    containsUnsupportedControl(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function optionalBaseUrl(
  value: unknown,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "")
    return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, error: "Base URL must be text." };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (
    trimmed.length > MAX_BASE_URL_LENGTH ||
    containsUnsupportedControl(trimmed)
  ) {
    return {
      ok: false,
      error: "Base URL is too long or contains an unsupported character.",
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Base URL must use http or https." };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: "Base URL must not contain credentials." };
    }
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false, error: "Base URL is not a valid URL." };
  }
}

function optionalNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer: boolean,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "")
    return { ok: true };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `${label} must be a number.` };
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    return {
      ok: false,
      error: `${label} must be ${integer ? "an integer " : ""}between ${min} and ${max}.`,
    };
  }
  return { ok: true, value };
}

function optionalFallback(
  value: unknown,
): { ok: true; value?: AgentModelTarget } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value) || !isProvider(value.provider)) {
    return {
      ok: false,
      error: "Fallback provider must be openai, anthropic, or google.",
    };
  }
  const model = modelName(value.model);
  if (!model) {
    return {
      ok: false,
      error: `Fallback model must be between 1 and ${MAX_MODEL_LENGTH} characters on one line.`,
    };
  }
  return { ok: true, value: { provider: value.provider, model } };
}

/** Validate settings at the HTTP boundary before they can reach the vault or CopilotKit runtime. */
export function parseAgentModelConfigInput(
  input: unknown,
): ParseAgentModelConfigResult {
  if (!isRecord(input)) {
    return { ok: false, error: "Model settings must be a JSON object." };
  }
  if (input.mode === "global") return { ok: true, value: { mode: "global" } };
  if (input.mode !== "custom") {
    return { ok: false, error: "Mode must be global or custom." };
  }
  if (!isProvider(input.provider)) {
    return {
      ok: false,
      error: "Provider must be openai, anthropic, or google.",
    };
  }
  const model = modelName(input.model);
  if (!model) {
    return {
      ok: false,
      error: `Model must be between 1 and ${MAX_MODEL_LENGTH} characters on one line.`,
    };
  }
  if (
    input.credentialSource !== "global" &&
    input.credentialSource !== "custom"
  ) {
    return { ok: false, error: "Credential source must be global or custom." };
  }

  const baseUrl = optionalBaseUrl(input.baseUrl);
  if (!baseUrl.ok) return baseUrl;
  // A custom endpoint is an OpenAI-compatible transport. Anthropic and Google use their native
  // providers unless/until we add an explicit adapter for their compatible gateways.
  if (baseUrl.value && input.provider !== "openai") {
    return {
      ok: false,
      error:
        "Base URL is currently supported only for OpenAI-compatible models.",
    };
  }
  const temperature = optionalNumber(
    input.temperature,
    "Temperature",
    MIN_TEMPERATURE,
    MAX_TEMPERATURE,
    false,
  );
  if (!temperature.ok) return temperature;
  const maxTokens = optionalNumber(
    input.maxTokens,
    "Max tokens",
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
    true,
  );
  if (!maxTokens.ok) return maxTokens;
  const fallback = optionalFallback(input.fallback);
  if (!fallback.ok) return fallback;

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
    if (containsUnsupportedControl(trimmed)) {
      return { ok: false, error: "API key contains an unsupported character." };
    }
    if (trimmed) apiKey = trimmed;
  }

  return {
    ok: true,
    value: {
      mode: "custom",
      provider: input.provider,
      model,
      credentialSource: input.credentialSource,
      ...(input.credentialSource === "custom" && apiKey ? { apiKey } : {}),
      ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}),
      ...(temperature.value !== undefined
        ? { temperature: temperature.value }
        : {}),
      ...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
      ...(fallback.value ? { fallback: fallback.value } : {}),
    },
  };
}

/** Read the model namespace from `agents.override`. Malformed rows fail closed to global defaults. */
export function storedAgentModelConfigFromOverride(
  override: unknown,
): StoredAgentModelConfig | null {
  if (!isRecord(override)) return null;
  const raw = override[AGENT_MODEL_OVERRIDE_KEY];
  if (!isRecord(raw) || !isProvider(raw.provider)) return null;

  const model = modelName(raw.model);
  if (!model) return null;

  const credentialId =
    typeof raw.credentialId === "string" && raw.credentialId.trim()
      ? raw.credentialId.trim()
      : undefined;
  const baseUrl = optionalBaseUrl(raw.baseUrl);
  const temperature = optionalNumber(
    raw.temperature,
    "Temperature",
    MIN_TEMPERATURE,
    MAX_TEMPERATURE,
    false,
  );
  const maxTokens = optionalNumber(
    raw.maxTokens,
    "Max tokens",
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
    true,
  );
  const fallback = optionalFallback(raw.fallback);
  if (!baseUrl.ok || !temperature.ok || !maxTokens.ok || !fallback.ok)
    return null;
  if (baseUrl.value && raw.provider !== "openai") return null;

  return {
    provider: raw.provider,
    model,
    ...(credentialId ? { credentialId } : {}),
    ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}),
    ...(temperature.value !== undefined
      ? { temperature: temperature.value }
      : {}),
    ...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
    ...(fallback.value ? { fallback: fallback.value } : {}),
  };
}

/** Replace only the model namespace and preserve every unrelated override owned by other features. */
export function withStoredAgentModelConfig(
  override: unknown,
  config: StoredAgentModelConfig | null,
): Record<string, unknown> | null {
  const next = isRecord(override) ? { ...override } : {};
  if (config) next[AGENT_MODEL_OVERRIDE_KEY] = config;
  else delete next[AGENT_MODEL_OVERRIDE_KEY];
  return Object.keys(next).length > 0 ? next : null;
}

export function publicAgentModelConfig(
  stored: StoredAgentModelConfig | null,
  hasApiKey: boolean,
): PublicAgentModelConfig {
  if (!stored) return { mode: "global" };
  const { credentialId: _credentialId, ...safe } = stored;
  return {
    mode: "custom",
    ...safe,
    credentialSource: stored.credentialId ? "custom" : "global",
    hasApiKey: stored.credentialId ? hasApiKey : false,
  };
}

/** CopilotKit runtime v2 accepts provider/model model specifiers. */
export function agentModelSpecifier(target: AgentModelTarget): string {
  return `${target.provider}/${target.model}`;
}
