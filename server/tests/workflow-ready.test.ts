import { describe, expect, test } from "bun:test";
import type { WorkItem, WorkQueue } from "../src/work/queue";
import {
  dispatchClaimedReadyWorkflowSteps,
  offerReadyWorkflowSteps,
  reconcileExhaustedReadyWorkflowSteps,
  WORKFLOW_READY_DISPATCH_KIND,
} from "../src/workflows/ready";
import { WorkflowCapacityError } from "../src/workflows/store";

function queueStub(overrides: Partial<WorkQueue> = {}): WorkQueue {
  return {
    offer: async () => "queued",
    claim: async () => [],
    claimExhausted: async () => [],
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
    purge: async () => 0,
    ...overrides,
  };
}

function item(attempts = 1): WorkItem {
  return {
    kind: WORKFLOW_READY_DISPATCH_KIND,
    key: "workflow-1:render:2026-09-19T16:00:00.000Z",
    attempts,
    payload: {
      ownerUserId: "user-1",
      agentId: "bot-1",
      workflowId: "workflow-1",
      stepKey: "render",
      readyAt: "2026-09-19T16:00:00.000Z",
      attempts: 0,
    },
  };
}

describe("workflow ready-step dispatch", () => {
  test("offers one idempotent item for the exact ready stamp", async () => {
    const readyAt = new Date("2026-09-19T16:00:00.000Z");
    const offered: Array<Record<string, unknown>> = [];
    const result = await offerReadyWorkflowSteps({
      owner: "worker-1",
      queue: queueStub({
        offer: async (work) => {
          offered.push(work as unknown as Record<string, unknown>);
          return "queued";
        },
      }),
      store: {
        readySteps: async () => [
          {
            ownerUserId: "user-1",
            agentId: "bot-1",
            workflowId: "workflow-1",
            stepKey: "render",
            readyAt,
            attempts: 0,
          },
        ],
        startReadyStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
      },
    });

    expect(result).toEqual({ queued: 1, already: 0 });
    expect(offered[0]).toMatchObject({
      kind: WORKFLOW_READY_DISPATCH_KIND,
      key: "workflow-1:render:2026-09-19T16:00:00.000Z",
      payload: {
        ownerUserId: "user-1",
        agentId: "bot-1",
        workflowId: "workflow-1",
        stepKey: "render",
        readyAt: "2026-09-19T16:00:00.000Z",
        attempts: 0,
      },
    });
  });

  test("starts the exact ready version before dispatching its new attempt", async () => {
    const order: string[] = [];
    let dispatchAttempt = 0;
    const report = await dispatchClaimedReadyWorkflowSteps({
      owner: "worker-1",
      queue: queueStub({
        claim: async () => [item()],
        finish: async () => {
          order.push("finish");
          return true;
        },
      }),
      store: {
        readySteps: async () => [],
        startReadyStep: async (_identity, _id, _key, readyAt, attempt) => {
          order.push("start");
          expect(readyAt.toISOString()).toBe("2026-09-19T16:00:00.000Z");
          expect(attempt).toBe(0);
          return { attempts: 1 } as never;
        },
        failStep: async () => {
          throw new Error("not used");
        },
      },
      dispatch: async (input) => {
        order.push("dispatch");
        dispatchAttempt = input.expectedAttempt;
      },
    });

    expect(order).toEqual(["start", "dispatch", "finish"]);
    expect(dispatchAttempt).toBe(1);
    expect(report.started).toEqual([
      { workflowId: "workflow-1", stepKey: "render" },
    ]);
  });

  test("keeps the lease alive for a long headless ready-step turn", async () => {
    let renewals = 0;
    await dispatchClaimedReadyWorkflowSteps({
      owner: "worker-1",
      leaseMs: 60,
      renewEveryMs: 5,
      queue: queueStub({
        claim: async () => [item()],
        renew: async () => {
          renewals += 1;
          return true;
        },
      }),
      store: {
        readySteps: async () => [],
        startReadyStep: async () => ({ attempts: 1 }) as never,
        failStep: async () => {
          throw new Error("not used");
        },
      },
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });

    expect(renewals).toBeGreaterThan(1);
  });

  test("defers capacity-blocked ready work without spending a retry", async () => {
    let deferred = 0;
    let released = 0;
    const report = await dispatchClaimedReadyWorkflowSteps({
      owner: "worker-1",
      retryDelayMs: 9_000,
      queue: queueStub({
        claim: async () => [item(4)],
        defer: async (input) => {
          deferred += 1;
          expect(input.delayMs).toBe(9_000);
          return true;
        },
        release: async () => {
          released += 1;
          return true;
        },
      }),
      store: {
        readySteps: async () => [],
        startReadyStep: async () => {
          throw new WorkflowCapacityError("workflow capacity is full");
        },
        failStep: async () => {
          throw new Error("not used");
        },
      },
    });

    expect(deferred).toBe(1);
    expect(released).toBe(0);
    expect(report.started).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("capacity");
  });

  test("releases a transient dispatch failure so the exact CAS can be retried", async () => {
    let released = 0;
    await dispatchClaimedReadyWorkflowSteps({
      owner: "worker-1",
      queue: queueStub({
        claim: async () => [item()],
        release: async () => {
          released += 1;
          return true;
        },
      }),
      store: {
        readySteps: async () => [],
        startReadyStep: async () => ({ attempts: 1 }) as never,
        failStep: async () => {
          throw new Error("not used");
        },
      },
      dispatch: async () => {
        throw new Error("gateway unavailable");
      },
    });

    expect(released).toBe(1);
  });

  test("reconciles a crash on the final ready dispatch attempt", async () => {
    const failed: unknown[][] = [];
    let finished = 0;
    const report = await reconcileExhaustedReadyWorkflowSteps({
      owner: "cleanup-1",
      maxAttempts: 5,
      queue: queueStub({
        claimExhausted: async () => [item(5)],
        finish: async () => {
          finished += 1;
          return true;
        },
      }),
      store: {
        readySteps: async () => [],
        startReadyStep: async () => {
          throw new Error("not used");
        },
        failStep: async () => {
          throw new Error("not used");
        },
        failReadyStep: async () => {
          throw new Error("should use running recovery first");
        },
        failAutonomousRunningStep: async (...args) => {
          failed.push(args);
          return {} as never;
        },
      },
    });

    expect(finished).toBe(1);
    expect(failed).toHaveLength(1);
    expect((failed[0]![3] as Date).toISOString()).toBe(
      "2026-09-19T16:00:00.000Z",
    );
    expect(failed[0]?.[4]).toBe(1);
    expect(report.skipped[0]?.reason).toContain("worker interruption");
  });

  test("fails the exact running attempt when autonomous retries are exhausted", async () => {
    const failures: unknown[][] = [];
    let released = 0;
    let finished = 0;

    await dispatchClaimedReadyWorkflowSteps({
      owner: "worker-1",
      maxAttempts: 2,
      queue: queueStub({
        claim: async () => [item(2)],
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
        readySteps: async () => [],
        startReadyStep: async () => ({ attempts: 1 }) as never,
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
    expect(failures[0]?.at(-1)).toBe(1);
    expect(String(failures[0]?.at(-2))).toContain("retry budget");
  });
});
