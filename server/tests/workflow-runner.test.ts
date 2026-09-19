import { describe, expect, test } from "bun:test";
import type { ChannelStore } from "../src/channels/routes";
import type { TurnRunner } from "../src/routines/runner";
import { createWorkflowRunner } from "../src/workflows/runner";
import type { WorkflowPlan, WorkflowStep } from "../src/workflows/store";

const NOW = new Date("2026-09-19T13:00:00.000Z");

function step(status: WorkflowStep["status"] = "running"): WorkflowStep {
  return {
    id: "step-1",
    workflowId: "workflow-1",
    key: "render",
    position: 0,
    instruction: "Inspect the generation result and continue scene one.",
    dependsOn: [],
    status,
    attempts: 2,
    provider: "flow",
    waitUntil: null,
    failureReason: null,
    startedAt: NOW,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function plan(
  status: WorkflowPlan["status"] = "active",
  current = step(),
): WorkflowPlan {
  return {
    id: "workflow-1",
    ownerUserId: "user-1",
    agentId: "bot-1",
    channelId: "channel-1",
    title: "Video pipeline",
    status,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    steps: [current],
  };
}

const INPUT = {
  ownerUserId: "user-1",
  agentId: "bot-1",
  workflowId: "workflow-1",
  stepKey: "render",
  expectedAttempt: 2,
};

function channelStore(overrides: Partial<ChannelStore> = {}): ChannelStore {
  return {
    get: async () =>
      ({
        id: "channel-1",
        name: "Video",
        threadId: "thread-1",
      }) as never,
    recordActivity: async () => undefined,
    ...overrides,
  } as ChannelStore;
}

describe("workflow autonomous continuation", () => {
  test("runs the current step as the workflow owner/Bot and asks for a durable checkpoint", async () => {
    const turnCalls: Parameters<TurnRunner>[0][] = [];
    const states = [plan(), plan("active", step("waiting"))];
    const runner = createWorkflowRunner({
      workflowStore: {
        get: async () => states.shift() ?? null,
        failStep: async () => step("failed"),
      },
      channelStore: channelStore(),
      runTurn: async (input) => {
        turnCalls.push(input);
        return {
          replyText: "Still generating, so I scheduled the next check.",
        };
      },
    });

    await runner.run(INPUT);

    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]).toMatchObject({
      ownerUserId: "user-1",
      agentId: "bot-1",
      workflowId: "workflow-1",
      threadId: "thread-1",
    });
    expect(turnCalls[0]?.instruction).toContain("Attempt: 2");
    expect(turnCalls[0]?.instruction).toContain(
      "Before repeating any external submission",
    );
    expect(turnCalls[0]?.instruction).toContain("checkpoint the step durably");
  });

  test("fails closed when a successful turn leaves the same attempt running", async () => {
    const failures: unknown[][] = [];
    const runner = createWorkflowRunner({
      workflowStore: {
        get: async () => plan(),
        failStep: async (...args) => {
          failures.push(args);
          return step("failed");
        },
      },
      channelStore: channelStore(),
      runTurn: async () => ({ replyText: "I am done." }),
    });

    await runner.run(INPUT);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.slice(1)).toEqual([
      "workflow-1",
      "render",
      "The autonomous continuation ended without checkpointing this workflow step.",
      2,
    ]);
  });

  test("does not run stale or newer attempts", async () => {
    let turns = 0;
    const newer = step();
    newer.attempts = 3;
    const runner = createWorkflowRunner({
      workflowStore: {
        get: async () => plan("active", newer),
        failStep: async () => step("failed"),
      },
      channelStore: channelStore(),
      runTurn: async () => {
        turns += 1;
        return { replyText: "should not run" };
      },
    });

    await runner.run(INPUT);
    expect(turns).toBe(0);
  });

  test("fails the exact attempt without running a model when its channel is gone", async () => {
    let turns = 0;
    const failures: unknown[][] = [];
    const runner = createWorkflowRunner({
      workflowStore: {
        get: async () => plan(),
        failStep: async (...args) => {
          failures.push(args);
          return step("failed");
        },
      },
      channelStore: channelStore({ get: async () => null }),
      runTurn: async () => {
        turns += 1;
        return { replyText: "should not run" };
      },
    });

    await runner.run(INPUT);
    expect(turns).toBe(0);
    expect(failures[0]?.at(-1)).toBe(2);
  });
});
