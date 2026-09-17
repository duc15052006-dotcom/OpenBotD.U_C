import type { RuntimeAgentModel } from "./runtime-model";

export type ModelConnectionFailureCode =
  | "credential_missing"
  | "authentication_failed"
  | "model_unavailable"
  | "rate_limited"
  | "provider_unavailable"
  | "request_rejected"
  | "timeout"
  | "unreachable";

export type ModelConnectionResult =
  | {
      ok: true;
      provider: RuntimeAgentModel["provider"];
      model: string;
    }
  | {
      ok: false;
      provider: RuntimeAgentModel["provider"];
      model: string;
      code: ModelConnectionFailureCode;
      error: string;
      status?: number;
    };

/**
 * A fetch chosen by the caller after applying the deployment's outbound-network policy.
 *
 * Deliberately mandatory. A custom Base URL is user-controlled, so giving this module a default of
 * global `fetch` would turn the first forgotten wiring into an SSRF path. OpenBot's caller should
 * pass `createAgentFetch(...)`, which validates the first address and every redirect and strips
 * credentials when a redirect leaves their scope.
 */
export type ModelProbeFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

function withoutTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizedGoogleModel(model: string) {
  return model.replace(/^models\//, "");
}

function probeRequest(runtime: RuntimeAgentModel): {
  url: string;
  headers: Record<string, string>;
} {
  if (!runtime.apiKey) {
    throw new Error("probeRequest requires a resolved credential");
  }

  const encoded = encodeURIComponent(runtime.defaultModel);
  if (runtime.provider === "openai") {
    const base = withoutTrailingSlashes(
      runtime.baseUrl ?? "https://api.openai.com/v1",
    );
    return {
      url: `${base}/models/${encoded}`,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runtime.apiKey}`,
      },
    };
  }

  if (runtime.provider === "anthropic") {
    return {
      url: `https://api.anthropic.com/v1/models/${encoded}`,
      headers: {
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": runtime.apiKey,
      },
    };
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizedGoogleModel(runtime.defaultModel),
    )}`,
    headers: {
      accept: "application/json",
      "x-goog-api-key": runtime.apiKey,
    },
  };
}

function failure(
  runtime: RuntimeAgentModel,
  code: ModelConnectionFailureCode,
  error: string,
  status?: number,
): ModelConnectionResult {
  return {
    ok: false,
    provider: runtime.provider,
    model: runtime.defaultModel,
    code,
    error,
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Verify that the selected provider accepts this credential for this model without spending a model
 * token. OpenAI and Anthropic both expose model-retrieve endpoints; Gemini's native Developer API
 * exposes the same model metadata. No provider response body is ever returned or logged here: an
 * upstream error may echo account or request details, and the settings screen only needs the class
 * of failure and HTTP status.
 */
export async function testAgentModelConnection(
  runtime: RuntimeAgentModel,
  guardedFetch: ModelProbeFetch,
  timeoutMs = 10_000,
): Promise<ModelConnectionResult> {
  if (!runtime.apiKey) {
    return failure(
      runtime,
      "credential_missing",
      "No API key is available for this Agent and provider.",
    );
  }

  const request = probeRequest(runtime);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await guardedFetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
      redirect: "manual",
    });

    if (response.ok) {
      return {
        ok: true,
        provider: runtime.provider,
        model: runtime.defaultModel,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return failure(
        runtime,
        "authentication_failed",
        "The provider rejected the API key or this account does not have access to the selected model.",
        response.status,
      );
    }
    if (response.status === 404) {
      return failure(
        runtime,
        "model_unavailable",
        "The provider could not find the selected model for this account.",
        response.status,
      );
    }
    if (response.status === 429) {
      return failure(
        runtime,
        "rate_limited",
        "The provider is reachable but this account is currently rate-limited or out of quota.",
        response.status,
      );
    }
    if (response.status >= 500) {
      return failure(
        runtime,
        "provider_unavailable",
        "The provider is reachable but is currently unavailable.",
        response.status,
      );
    }
    return failure(
      runtime,
      "request_rejected",
      "The provider rejected the model check.",
      response.status,
    );
  } catch {
    if (controller.signal.aborted) {
      return failure(
        runtime,
        "timeout",
        "The model provider did not answer before the connection test timed out.",
      );
    }
    // Do not include the thrown message. A guarded fetch may name an internal target in its refusal,
    // and a network/TLS error may contain deployment details that do not belong in a browser reply.
    return failure(
      runtime,
      "unreachable",
      "This deployment could not reach the model provider endpoint.",
    );
  } finally {
    clearTimeout(timer);
  }
}
