import { describe, expect, spyOn, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { FallbackAgent } from "../src/copilot";

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
  state: {},
};

const event = (value: Record<string, unknown>) => value as BaseEvent;

class ScriptedAgent extends AbstractAgent {
  runs = 0;
  aborts = 0;

  constructor(
    private readonly stream: (input: RunAgentInput) => Observable<BaseEvent>,
    description: string,
  ) {
    super({ agentId: description, description });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runs += 1;
    return this.stream(input);
  }

  clone(): ScriptedAgent {
    return new ScriptedAgent(this.stream, this.description ?? "scripted");
  }

  abortRun(): void {
    this.aborts += 1;
  }
}

function scripted(events: BaseEvent[], failure?: Error) {
  return new Observable<BaseEvent>((subscriber) => {
    for (const item of events) subscriber.next(item);
    if (failure) subscriber.error(failure);
    else subscriber.complete();
  });
}

async function collect(agent: AbstractAgent) {
  const events: BaseEvent[] = [];
  let error: unknown;
  await new Promise<void>((resolve) => {
    agent.run(input).subscribe({
      next: (item) => events.push(item),
      error: (reason) => {
        error = reason;
        resolve();
      },
      complete: resolve,
    });
  });
  return { events, error };
}

function fallbackAgent(primary: ScriptedAgent, fallback: ScriptedAgent) {
  return new FallbackAgent(
    { agentId: "writer", description: "Writer" },
    primary,
    fallback,
    { provider: "openai", model: "gpt-primary" },
    { provider: "anthropic", model: "claude-fallback" },
  );
}

describe("per-Agent model fallback", () => {
  test("retries a provider RUN_ERROR before visible output", async () => {
    const primary = new ScriptedAgent(
      () =>
        scripted(
          [
            event({
              type: "RUN_STARTED",
              threadId: "thread-1",
              runId: "run-1",
            }),
            event({
              type: "RUN_ERROR",
              threadId: "thread-1",
              runId: "run-1",
              message: "primary unavailable",
            }),
          ],
          new Error("primary unavailable"),
        ),
      "primary",
    );
    const fallback = new ScriptedAgent(
      () =>
        scripted([
          event({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" }),
          event({
            type: "TEXT_MESSAGE_CHUNK",
            role: "assistant",
            messageId: "answer-1",
            delta: "fallback answer",
          }),
          event({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" }),
        ]),
      "fallback",
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await collect(fallbackAgent(primary, fallback));

      expect(result.error).toBeUndefined();
      expect(result.events.map((item) => item.type)).toEqual([
        "RUN_STARTED",
        "TEXT_MESSAGE_CHUNK",
        "RUN_FINISHED",
      ]);
      expect(primary.runs).toBe(1);
      expect(fallback.runs).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "agent_model_fallback",
          agentId: "writer",
          primary: { provider: "openai", model: "gpt-primary" },
          fallback: { provider: "anthropic", model: "claude-fallback" },
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("does not retry after text has already escaped", async () => {
    const primary = new ScriptedAgent(
      () =>
        scripted(
          [
            event({
              type: "RUN_STARTED",
              threadId: "thread-1",
              runId: "run-1",
            }),
            event({
              type: "TEXT_MESSAGE_CHUNK",
              role: "assistant",
              messageId: "answer-1",
              delta: "partial",
            }),
            event({ type: "RUN_ERROR", message: "stream failed" }),
          ],
          new Error("stream failed"),
        ),
      "primary",
    );
    const fallback = new ScriptedAgent(() => scripted([]), "fallback");
    const result = await collect(fallbackAgent(primary, fallback));

    expect(result.events.map((item) => item.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CHUNK",
      "RUN_ERROR",
    ]);
    expect(result.error).toBeInstanceOf(Error);
    expect(fallback.runs).toBe(0);
  });

  test("does not treat a local raw error as a provider failure", async () => {
    const primary = new ScriptedAgent(
      () => scripted([], new Error("attachment could not be loaded")),
      "primary",
    );
    const fallback = new ScriptedAgent(() => scripted([]), "fallback");
    const result = await collect(fallbackAgent(primary, fallback));

    expect(result.events.map((item) => item.type)).toEqual(["RUN_STARTED"]);
    expect(result.error).toEqual(new Error("attachment could not be loaded"));
    expect(fallback.runs).toBe(0);
  });

  test("passes through the fallback error when both providers fail", async () => {
    const failure = (message: string) =>
      scripted(
        [
          event({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" }),
          event({ type: "RUN_ERROR", message }),
        ],
        new Error(message),
      );
    const primary = new ScriptedAgent(
      () => failure("primary failed"),
      "primary",
    );
    const fallback = new ScriptedAgent(
      () => failure("fallback failed"),
      "fallback",
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await collect(fallbackAgent(primary, fallback));

      expect(result.events.map((item) => item.type)).toEqual([
        "RUN_STARTED",
        "RUN_ERROR",
      ]);
      expect((result.events[1] as { message?: string }).message).toBe(
        "fallback failed",
      );
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("fallback failed");
    } finally {
      warning.mockRestore();
    }
  });

  test("keeps the conversation when the runtime clones the fallback agent", async () => {
    const seen: RunAgentInput["messages"][] = [];
    const providerFailure = () =>
      scripted(
        [
          event({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" }),
          event({ type: "RUN_ERROR", message: "primary failed" }),
        ],
        new Error("primary failed"),
      );
    const primary = new ScriptedAgent(providerFailure, "primary");
    const fallback = new ScriptedAgent((received) => {
      seen.push(received.messages);
      return scripted([
        event({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" }),
        event({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" }),
      ]);
    }, "fallback");
    const agent = fallbackAgent(primary, fallback);
    agent.setMessages([
      { id: "message-1", role: "user", content: "Keep this message." },
    ]);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await agent.clone().runAgent();
    } finally {
      warning.mockRestore();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toMatchObject({
      id: "message-1",
      role: "user",
      content: "Keep this message.",
    });
  });
});
