import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { agentModelSpecifier } from "./model-config";
import type { RuntimeAgentModel } from "./runtime-model";

export type BuiltInModelConfiguration = Pick<
  BuiltInAgentConfiguration,
  "model" | "apiKey" | "temperature" | "maxOutputTokens"
>;

export class AgentModelBaseUrlUnavailableError extends Error {
  constructor(baseUrl: string) {
    super(
      `The custom model endpoint ${baseUrl} is configured, but this runtime has no OpenAI-compatible provider factory.`,
    );
    this.name = "AgentModelBaseUrlUnavailableError";
  }
}

/**
 * Translate OpenBot's provider-neutral model settings to the exact CopilotKit v2 fields.
 *
 * `maxTokens` is our stable UI/storage name; CopilotKit's current field is `maxOutputTokens`. Keeping
 * that translation here prevents the browser/database contract from changing whenever an SDK names
 * a sampling option differently.
 *
 * A custom Base URL is never ignored. Native provider strings let CopilotKit choose its built-in
 * provider transport; an OpenAI-compatible endpoint instead needs an AI SDK LanguageModel instance.
 * Until the caller supplies that factory, refusing is safer than showing a custom endpoint in the UI
 * while secretly sending the key and request to the public provider.
 */
export function builtInModelConfiguration(
  runtime: RuntimeAgentModel,
  compatibleModel?: (input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }) => BuiltInAgentConfiguration["model"],
): BuiltInModelConfiguration | null {
  if (!runtime.apiKey) return null;

  const model = runtime.baseUrl
    ? compatibleModel?.({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        model: runtime.defaultModel,
      })
    : agentModelSpecifier({
        provider: runtime.provider,
        model: runtime.defaultModel,
      });

  if (runtime.baseUrl && !model) {
    throw new AgentModelBaseUrlUnavailableError(runtime.baseUrl);
  }

  return {
    model: model as BuiltInAgentConfiguration["model"],
    // A LanguageModel created for a custom endpoint already owns its key. For provider/model strings,
    // the key is explicit so per-Agent credentials never fall back to an unrelated process env var.
    ...(runtime.baseUrl ? {} : { apiKey: runtime.apiKey }),
    ...(runtime.temperature !== undefined
      ? { temperature: runtime.temperature }
      : {}),
    ...(runtime.maxTokens !== undefined
      ? { maxOutputTokens: runtime.maxTokens }
      : {}),
  };
}
