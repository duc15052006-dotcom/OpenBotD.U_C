import {
  WorkflowCapacityError,
  WorkflowRefusedError,
  type WorkflowStore,
} from "./store";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";

export const WORKFLOW_READY_DISPATCH_KIND = "workflow_ready_dispatch";

const DEFAULT_LIMIT = 50;
const DEFAULT_LEASE_MS = 6 * 60_000;
const DEFAULT_RENEW_EVERY_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type WorkflowReadyStore = Pick<
  WorkflowStore,
  "readySteps" | "startReadyStep" | "failStep"
> &
  Partial<Pick<WorkflowStore, "failReadyStep" | "failAutonomousRunningStep">>;

export type WorkflowReadyOptions = {
  store: WorkflowReadyStore;
  queue: WorkQueue;
  owner: string;
  dispatch?: (input: {
    ownerUserId: string;
    agentId: string;
    workflowId: string;
    stepKey: string;
    expectedAttempt: number;
  }) => Promise<void>;
  limit?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  renewEveryMs?: number;
  maxAttempts?: number;
};

export type WorkflowReadyReport = {
  considered: number;
  started: Array<{ workflowId: string; stepKey: string }>;
  skipped: Array<{ workflowId: string; stepKey: string; reason: string }>;
};

function readyKey(workflowId: string, stepKey: string, readyAt: Date): string {
  return `${workflowId}:${stepKey}:${readyAt.toISOString()}`;
}

export async function offerReadyWorkflowSteps(
  options: WorkflowReadyOptions,
): Promise<{ queued: number; already: number }> {
  const ready = await options.store.readySteps(options.limit ?? DEFAULT_LIMIT);
  let queued = 0;
  let already = 0;

  for (const step of ready) {
    const outcome = await options.queue.offer({
      kind: WORKFLOW_READY_DISPATCH_KIND,
      key: readyKey(step.workflowId, step.stepKey, step.readyAt),
      payload: {
        ownerUserId: step.ownerUserId,
        agentId: step.agentId,
        workflowId: step.workflowId,
        stepKey: step.stepKey,
        readyAt: step.readyAt.toISOString(),
        attempts: step.attempts,
      },
    });
    if (outcome === "queued") queued += 1;
    if (outcome === "already") already += 1;
  }

  return { queued, already };
}

export async function dispatchClaimedReadyWorkflowSteps(
  options: WorkflowReadyOptions,
): Promise<WorkflowReadyReport> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claim({
    kind: WORKFLOW_READY_DISPATCH_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    maxAttempts,
  });

  const report: WorkflowReadyReport = {
    considered: claimed.length,
    started: [],
    skipped: [],
  };

  for (const item of claimed) {
    const workflowId =
      typeof item.payload.workflowId === "string"
        ? item.payload.workflowId
        : "";
    const stepKey =
      typeof item.payload.stepKey === "string" ? item.payload.stepKey : "";
    const ownerUserId =
      typeof item.payload.ownerUserId === "string"
        ? item.payload.ownerUserId
        : "";
    const agentId =
      typeof item.payload.agentId === "string" ? item.payload.agentId : "";
    const readyAt =
      typeof item.payload.readyAt === "string"
        ? new Date(item.payload.readyAt)
        : null;
    const expectedAttempt =
      typeof item.payload.attempts === "number" &&
      Number.isInteger(item.payload.attempts) &&
      item.payload.attempts >= 0
        ? item.payload.attempts
        : -1;

    if (
      !workflowId ||
      !stepKey ||
      !ownerUserId ||
      !agentId ||
      expectedAttempt < 0 ||
      !readyAt ||
      Number.isNaN(readyAt.getTime())
    ) {
      const reason = "workflow ready payload is incomplete or invalid";
      await options.queue.finish({
        kind: WORKFLOW_READY_DISPATCH_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({ workflowId, stepKey, reason });
      continue;
    }

    const renewed = await options.queue.renew({
      kind: WORKFLOW_READY_DISPATCH_KIND,
      key: item.key,
      owner: options.owner,
      leaseMs,
    });
    if (!renewed) {
      report.skipped.push({
        workflowId,
        stepKey,
        reason: "the lease went to another replica",
      });
      continue;
    }

    let startedAttempt: number | undefined;
    try {
      const started = await options.store.startReadyStep(
        { ownerUserId, agentId },
        workflowId,
        stepKey,
        readyAt,
        expectedAttempt,
      );
      startedAttempt = started.attempts;

      if (options.dispatch) {
        const renewEveryMs =
          options.renewEveryMs ??
          Math.min(
            DEFAULT_RENEW_EVERY_MS,
            Math.max(1_000, Math.floor(leaseMs / 3)),
          );
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          heartbeat = setInterval(() => {
            void options.queue
              .renew({
                kind: WORKFLOW_READY_DISPATCH_KIND,
                key: item.key,
                owner: options.owner,
                leaseMs,
              })
              .catch(() => {});
          }, renewEveryMs);
          heartbeat.unref?.();

          const stillOurs = await options.queue.renew({
            kind: WORKFLOW_READY_DISPATCH_KIND,
            key: item.key,
            owner: options.owner,
            leaseMs,
          });
          if (!stillOurs) {
            report.skipped.push({
              workflowId,
              stepKey,
              reason: "the lease went to another replica before continuation",
            });
            continue;
          }

          await options.dispatch({
            ownerUserId,
            agentId,
            workflowId,
            stepKey,
            expectedAttempt: startedAttempt,
          });
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
      }

      await options.queue.finish({
        kind: WORKFLOW_READY_DISPATCH_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.started.push({ workflowId, stepKey });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "workflow ready step could not start";

      if (error instanceof WorkflowCapacityError) {
        if (!options.queue.defer) {
          throw new Error(
            "work queue defer is unavailable for workflow capacity backoff",
          );
        }
        await options.queue.defer({
          kind: WORKFLOW_READY_DISPATCH_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
          reason,
        });
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      // A newer/manual start, pause/cancel, or changed ready stamp makes this exact queue item
      // permanently stale. Finishing it is safe because a later ready transition gets a new stamp.
      if (
        /ready step changed|another attempt|does not exist|active workflow|not ready/i.test(
          reason,
        )
      ) {
        await options.queue.finish({
          kind: WORKFLOW_READY_DISPATCH_KIND,
          key: item.key,
          owner: options.owner,
        });
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      // Once this exact ready item has performed its CAS, exhausting the queue retry budget must
      // not leave the step permanently "running". Fail that exact attempt so the durable workflow
      // records a visible terminal reason and can be retried deliberately.
      if (startedAttempt !== undefined && item.attempts >= maxAttempts) {
        try {
          await options.store.failStep(
            { ownerUserId, agentId },
            workflowId,
            stepKey,
            `Autonomous continuation exhausted its retry budget: ${reason}`,
            startedAttempt,
          );
        } finally {
          await options.queue.finish({
            kind: WORKFLOW_READY_DISPATCH_KIND,
            key: item.key,
            owner: options.owner,
          });
        }
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      await options.queue.release({
        kind: WORKFLOW_READY_DISPATCH_KIND,
        key: item.key,
        owner: options.owner,
        delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        reason,
      });
      report.skipped.push({ workflowId, stepKey, reason });
    }
  }

  return report;
}

export async function reconcileExhaustedReadyWorkflowSteps(
  options: WorkflowReadyOptions,
): Promise<WorkflowReadyReport> {
  if (
    !options.queue.claimExhausted ||
    !options.store.failReadyStep ||
    !options.store.failAutonomousRunningStep
  ) {
    throw new Error(
      "exhausted workflow ready recovery capabilities are unavailable",
    );
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claimExhausted({
    kind: WORKFLOW_READY_DISPATCH_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    maxAttempts,
  });
  const report: WorkflowReadyReport = {
    considered: claimed.length,
    started: [],
    skipped: [],
  };

  for (const item of claimed) {
    const workflowId =
      typeof item.payload.workflowId === "string"
        ? item.payload.workflowId
        : "";
    const stepKey =
      typeof item.payload.stepKey === "string" ? item.payload.stepKey : "";
    const ownerUserId =
      typeof item.payload.ownerUserId === "string"
        ? item.payload.ownerUserId
        : "";
    const agentId =
      typeof item.payload.agentId === "string" ? item.payload.agentId : "";
    const readyAt =
      typeof item.payload.readyAt === "string"
        ? new Date(item.payload.readyAt)
        : null;
    const expectedAttempt =
      typeof item.payload.attempts === "number" &&
      Number.isInteger(item.payload.attempts) &&
      item.payload.attempts >= 0
        ? item.payload.attempts
        : -1;

    if (
      !workflowId ||
      !stepKey ||
      !ownerUserId ||
      !agentId ||
      expectedAttempt < 0 ||
      !readyAt ||
      Number.isNaN(readyAt.getTime())
    ) {
      await options.queue.finish({
        kind: WORKFLOW_READY_DISPATCH_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({
        workflowId,
        stepKey,
        reason: "exhausted workflow ready payload is invalid",
      });
      continue;
    }

    const identity = { ownerUserId, agentId };
    const failure =
      "Autonomous ready-step continuation exhausted its retry budget after a worker interruption.";
    try {
      try {
        await options.store.failAutonomousRunningStep(
          identity,
          workflowId,
          stepKey,
          readyAt,
          expectedAttempt + 1,
          failure,
        );
      } catch (error) {
        if (!(error instanceof WorkflowRefusedError)) throw error;
        await options.store.failReadyStep(
          identity,
          workflowId,
          stepKey,
          readyAt,
          expectedAttempt,
          failure,
        );
      }
      await options.queue.finish({
        kind: WORKFLOW_READY_DISPATCH_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({ workflowId, stepKey, reason: failure });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "exhausted ready cleanup failed";
      if (error instanceof WorkflowRefusedError) {
        await options.queue.finish({
          kind: WORKFLOW_READY_DISPATCH_KIND,
          key: item.key,
          owner: options.owner,
        });
      } else {
        await options.queue.release({
          kind: WORKFLOW_READY_DISPATCH_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
          reason,
        });
      }
      report.skipped.push({ workflowId, stepKey, reason });
    }
  }
  return report;
}

export async function sweepReadyWorkflowSteps(
  options: WorkflowReadyOptions,
): Promise<WorkflowReadyReport & { queued: number; already: number }> {
  const offered = await offerReadyWorkflowSteps(options);
  const dispatched = await dispatchClaimedReadyWorkflowSteps(options);
  const recovered = await reconcileExhaustedReadyWorkflowSteps(options);
  return {
    ...offered,
    considered: dispatched.considered + recovered.considered,
    started: dispatched.started,
    skipped: [...dispatched.skipped, ...recovered.skipped],
  };
}

export const WORKFLOW_READY_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
