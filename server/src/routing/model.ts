import type { RuntimeModel } from "../copilot";

/**
 * The one model call the router makes, kept apart from the routing logic so that logic stays a pure
 * function the tests drive without a network. This reuses the deployment's own model and key — the
 * same ones the built-in coworkers answer on — so a router is never a second thing to configure.
 *
 * It throws on a missing key or a bad response on purpose: the router treats a throw as "not sure"
 * and lands on the default, so failure here is a soft landing, not an error a person sees.
 */
export function createModelCompleter(deps: {
  model: { provider: "openai" | "anthropic"; defaultModel: string };
  resolveApiKey: () => Promise<string | null>;
}) {
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const key = await deps.resolveApiKey();
    signal?.throwIfAborted();
    if (!key) throw new Error("no model key");

    const anthropic = deps.model.provider === "anthropic";
    const response = await fetch(
      anthropic
        ? anthropicMessagesUrl(process.env)
        : chatCompletionsUrl(process.env),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: deps.model.defaultModel,
          ...(anthropic
            ? { max_tokens: 1024 }
            : { response_format: { type: "json_object" } }),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`router model answered ${response.status}`);

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const content = anthropic
      ? body.content
          ?.filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("") || undefined
      : body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("router model returned no text");
    return content;
  };
}

export function chatCompletionsUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com")
    // A trailing slash is the difference between `/v1` and `/v1/`, and no more than that.
    .replace(/\/+$/, "");
  return /\/v\d+$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/** Native Anthropic endpoint, accepting the same versioned base URL as the runtime. */
export function anthropicMessagesUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (
    environment.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}
