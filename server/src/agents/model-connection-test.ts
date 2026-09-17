import type { RuntimeAgentModel } from "./runtime-model";

export type ModelConnectionTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: string; status?: number };

type FetchLike = typeof fetch;

/**
 * Verify that a resolved provider/model/key combination is usable without spending model tokens.
 *
 * Every probe is read-only. Provider response bodies are deliberately not forwarded to the caller:
 * they may contain account metadata and are not needed to tell somebody which setting is wrong.
 */
export async function testModelConnection(
  model: RuntimeAgentModel,
  fetcher: FetchLike = fetch,
): Promise<ModelConnectionTestResult> {
  if (!model.apiKey) {
    return { ok: false, error: "No API key is configured for this provider." };
  }

  const started = performance.now();
  try {
    const request = modelProbeRequest(model);
    const response = await fetcher(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: providerFailureMessage(response.status),
        status: response.status,
      };
    }

    if (request.mustContainModel) {
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!modelListContains(payload, model.defaultModel)) {
        return {
          ok: false,
          error: "The API key works, but that model was not returned by the provider.",
          status: 404,
        };
      }
    }

    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, error: "The provider did not respond within 10 seconds." };
    }
    // Do not interpolate the thrown value. Fetch errors can include a URL containing gateway query
    // parameters, and no network error is worth reflecting deployment details into the browser.
    return { ok: false, error: "The provider could not be reached." };
  }
}

function modelProbeRequest(model: RuntimeAgentModel): {
  url: string;
  headers: Record<string, string>;
  mustContainModel: boolean;
} {
  if (model.provider === "anthropic") {
    return {
      url: `https://api.anthropic.com/v1/models/${encodeURIComponent(model.defaultModel)}`,
      headers: {
        "x-api-key": model.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      mustContainModel: false,
    };
  }

  if (model.provider === "google") {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
      headers: { Authorization: `Bearer ${model.apiKey ?? ""}` },
      mustContainModel: true,
    };
  }

  if (model.baseUrl) {
    const base = model.baseUrl.replace(/\/+$/, "");
    return {
      url: `${base}/models`,
      headers: { Authorization: `Bearer ${model.apiKey ?? ""}` },
      mustContainModel: true,
    };
  }

  return {
    url: `https://api.openai.com/v1/models/${encodeURIComponent(model.defaultModel)}`,
    headers: { Authorization: `Bearer ${model.apiKey ?? ""}` },
    mustContainModel: false,
  };
}

function providerFailureMessage(status: number) {
  if (status === 401 || status === 403) {
    return "The provider rejected the API key or its permissions.";
  }
  if (status === 404) return "The selected model was not found.";
  if (status === 429) return "The provider rate-limited the connection test.";
  return `The provider returned HTTP ${status}.`;
}

function modelListContains(payload: unknown, model: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && (id === model || id === `models/${model}`);
  });
}
