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

function classifyFailure(
  runtime: RuntimeAgentModel,
  status: number,
): ModelConnectionResult {
  if (status === 401 || status === 403) {
    return failure(
      runtime,
      "authentication_failed",
      "The provider rejected the API key or this account does not have access to the selected model.",
      status,
    );
  }
  if (status === 404) {
    return failure(
      runtime,
      "model_unavailable",
      "The provider could not find the selected model for this account.",
      status,
    );
  }
  if (status === 429) {
    return failure(
      runtime,
      "rate_limited",
      "The provider is reachable but this account is currently rate-limited or out of quota.",
      status,
    );
  }
  if (status >= 500) {
    return failure(
      runtime,
      "provider_unavailable",
      "The provider is reachable but is currently unavailable.",
      status,
    );
  }
  return failure(
    runtime,
    "request_rejected",
    "The provider rejected the model check.",
    status,
  );
}

async function testOpenAiCompatibleEndpoint(
  runtime: RuntimeAgentModel,
  guardedFetch: ModelProbeFetch,
  signal: AbortSignal,
): Promise<ModelConnectionResult> {
  if (!runtime.apiKey || !runtime.baseUrl) {
    throw new Error(
      "compatible probe requires a custom endpoint and credential",
    );
  }

  const base = withoutTrailingSlashes(runtime.baseUrl);
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${runtime.apiKey}`,
  };

  // A model catalogue proves only that the key may read metadata. It does NOT prove inference
  // quota. xKiro, for example, can return the selected free model from /models after that account's
  // daily free-token allowance is exhausted, while /chat/completions correctly returns 429. The old
  // early-success path therefore told the settings screen "Connected" and the very next real Bot
  // turn failed. Keep the catalogue as a cheap early authentication/provider-health check, but a
  // compatible endpoint is successful only after one real, tightly bounded completion.
  const catalog = await guardedFetch(`${base}/models`, {
    method: "GET",
    headers,
    signal,
    redirect: "manual",
  });
  if (
    !catalog.ok &&
    ([401, 403, 429].includes(catalog.status) || catalog.status >= 500)
  ) {
    return classifyFailure(runtime, catalog.status);
  }

  // Verify the same inference transport the Bot will use. One output token is enough to distinguish
  // a usable credential/model from an account whose free quota is already exhausted, without turning
  // a settings check into meaningful token spend. Provider response bodies remain private.
  const completion = await guardedFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: runtime.defaultModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
    redirect: "manual",
  });

  if (completion.ok) {
    return {
      ok: true,
      provider: runtime.provider,
      model: runtime.defaultModel,
    };
  }
  return classifyFailure(runtime, completion.status);
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
 * Verify that the selected provider accepts this credential for this model.
 *
 * Native OpenAI, Anthropic and Google endpoints use model metadata and spend no inference tokens.
 * OpenAI-compatible gateways use GET /models only as a cheap preflight, then always make a one-token
 * chat completion. A catalogue success cannot prove inference quota, and reporting it as "Connected"
 * is misleading when the account's next real generation returns 429. No provider response body is
 * returned or logged.
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
    if (runtime.provider === "openai" && runtime.baseUrl) {
      return await testOpenAiCompatibleEndpoint(
        runtime,
        guardedFetch,
        controller.signal,
      );
    }

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
    return classifyFailure(runtime, response.status);
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
