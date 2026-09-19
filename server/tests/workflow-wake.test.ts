import { describe, expect, test } from "bun:test";
import type { WorkItem, WorkQueue } from "../src/work/queue";
import {
  dispatchClaimedWorkflowWaits,
  offerDueWorkflowWaits,
  WORKFLOW_WAIT_RESUME_KIND,
} from "../src/workflows/wake";

function queueStub(overrides: Partial<WorkQueue> = {}): WorkQueue {
  return {
    offer: async () => "queued",
    claim: async () => [],
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
    purge: async () => 0,
    ...overrides,
  };
}

describe("workflow wake bridge", () => {
  test("offers one idempotent item for the exact persisted wait", async () => {
    const waitUntil = new Date("2026-09-20T07:30:00.000Z");
    const offered: Array<Record<string, unknown>> = [];
    const queue = queueStub({
      offer: async (item) => {
        offered.push(item as unknown as Record<string, unknown>);
        return "queued";
      },
    });

    const result = await offerDueWorkflowWaits({
      owner: "worker-1",
      queue,
      store: {
        dueWaitingSteps: async () => [
          {
            ownerUserId: "user-1",
            agentId: "bot-1",
            workflowId: "workflow-1",
            stepKey: "render",
            waitUntil,
            attempts: 1,
          },
        ],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => {
          throw new Error("not used");
        },
      },
    });

    expect(result).toEqual({ queued: 1, already: 0 });
    expect(offered[0]).toMatchObject({
      kind: WORKFLOW_WAIT_RESUME_KIND,
      key: "workflow-1:render:2026-09-20T07:30:00.000Z",
      payload: {
        ownerUserId: "user-1",
        agentId: "bot-1",
        workflowId: "workflow-1",
        stepKey: "render",
        waitUntil: "2026-09-20T07:30:00.000Z",
        attempts: 1,
      },
    });
  });

  test("resumes with identity and exact timestamp from the durable item", async () => {
    const item: WorkItem = {
      kind: WORKFLOW_WAIT_RESUME_KIND,
      key: "wake-1",
      attempts: 1,
      payload: {
        ownerUserId: "user-1",
        agentId: "bot-1",
        workflowId: "workflow-1",
        stepKey: "render",
        waitUntil: "2026-09-20T07:30:00.000Z",
        attempts: 1,
      },
    };
    const calls: unknown[][] = [];
    const report = await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      queue: queueStub({ claim: async () => [item] }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async (...args) => {
          calls.push(args);
          return {} as never;
        },
      },
    });

    expect(report.resumed).toEqual([
      { workflowId: "workflow-1", stepKey: "render" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      ownerUserId: "user-1",
      agentId: "bot-1",
    });
    expect((calls[0]?.[3] as Date | undefined)?.toISOString()).toBe(
      "2026-09-20T07:30:00.000Z",
    );
    expect(calls[0]?.[4]).toBe(1);
  });

  test("dispatches the headless continuation before finishing the wake", async () => {
    const order: string[] = [];
    const item: WorkItem = {
      kind: WORKFLOW_WAIT_RESUME_KIND,
      key: "wake-1",
      attempts: 1,
      payload: {
        ownerUserId: "user-1",
        agentId: "bot-1",
        workflowId: "workflow-1",
        stepKey: "render",
        waitUntil: "2026-09-20T07:30:00.000Z",
        attempts: 2,
      },
    };

    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      queue: queueStub({
        claim: async () => [item],
        finish: async () => {
          order.push("finish");
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => {
          order.push("resume");
          return {} as never;
        },
      },
      dispatch: async (input) => {
        order.push("dispatch");
        expect(input).toEqual({
          ownerUserId: "user-1",
          agentId: "bot-1",
          workflowId: "workflow-1",
          stepKey: "render",
          expectedAttempt: 2,
        });
      },
    });

    expect(order).toEqual(["resume", "dispatch", "finish"]);
  });

  test("renews the queue lease while a headless continuation is running", async () => {
    let renewals = 0;
    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      leaseMs: 60,
      renewEveryMs: 5,
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 1,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 2,
            },
          },
        ],
        renew: async () => {
          renewals += 1;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => ({}) as never,
      },
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });

    // One renewal before the continuation plus heartbeat renewals while it is running.
    expect(renewals).toBeGreaterThan(1);
  });

  test("releases the same wake when headless dispatch fails", async () => {
    let released = 0;
    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 1,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 2,
            },
          },
        ],
        release: async () => {
          released += 1;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => ({}) as never,
      },
      dispatch: async () => {
        throw new Error("gateway unavailable");
      },
    });
    expect(released).toBe(1);
  });

  test("fails the exact running attempt when a resumed wake exhausts dispatch retries", async () => {
    const failures: unknown[][] = [];
    let released = 0;
    let finished = 0;

    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      maxAttempts: 2,
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 2,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 3,
            },
          },
        ],
        release: async () => {
          released += 1;
          return true;
        },
        finish: async () => {
          finished += 1;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        resumeWaitingStep: async () => ({}) as never,
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async (...args) => {
          failures.push(args);
          return {} as never;
        },
      },
      dispatch: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(released).toBe(0);
    expect(finished).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.at(-1)).toBe(3);
    expect(String(failures[0]?.at(-2))).toContain("retry budget");
  });

  test("fails the exact waiting attempt when the final retry dies before resume CAS", async () => {
    let released = 0;
    let runningFailed = 0;
    const waitingFailures: unknown[][] = [];
    let finished = 0;

    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      maxAttempts: 2,
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 2,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 3,
            },
          },
        ],
        release: async () => {
          released += 1;
          return true;
        },
        finish: async () => {
          finished += 1;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        resumeWaitingStep: async () => {
          throw new Error("database temporarily unavailable");
        },
        failWaitingStep: async (...args) => {
          waitingFailures.push(args);
          return {} as never;
        },
        failStep: async () => {
          runningFailed += 1;
          return {} as never;
        },
      },
    });

    expect(released).toBe(0);
    expect(finished).toBe(1);
    expect(runningFailed).toBe(0);
    expect(waitingFailures).toHaveLength(1);
    expect((waitingFailures[0]![3] as Date).toISOString()).toBe(
      "2026-09-20T07:30:00.000Z",
    );
    expect(waitingFailures[0]![4]).toBe(3);
    expect(String(waitingFailures[0]![5])).toContain("retry budget");
  });

  test("finishes a stale exact wake instead of retrying it", async () => {
    let finished = 0;
    let released = 0;
    const report = await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 1,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 1,
            },
          },
        ],
        finish: async () => {
          finished += 1;
          return true;
        },
        release: async () => {
          released += 1;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => {
          throw new Error(
            "That wait is not due, or it was changed after this wake was scheduled.",
          );
        },
      },
    });

    expect(finished).toBe(1);
    expect(released).toBe(0);
    expect(report.resumed).toEqual([]);
    expect(report.skipped).toHaveLength(1);
  });

  test("releases transient failures with backoff", async () => {
    let delayMs = 0;
    await dispatchClaimedWorkflowWaits({
      owner: "worker-1",
      retryDelayMs: 7_000,
      queue: queueStub({
        claim: async () => [
          {
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: "wake-1",
            attempts: 1,
            payload: {
              ownerUserId: "user-1",
              agentId: "bot-1",
              workflowId: "workflow-1",
              stepKey: "render",
              waitUntil: "2026-09-20T07:30:00.000Z",
              attempts: 1,
            },
          },
        ],
        release: async (input) => {
          delayMs = input.delayMs;
          return true;
        },
      }),
      store: {
        dueWaitingSteps: async () => [],
        failWaitingStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        resumeWaitingStep: async () => {
          throw new Error("database temporarily unavailable");
        },
      },
    });
    expect(delayMs).toBe(7_000);
  });
});
