import {
  WorkflowCapacityError,
  WorkflowRefusedError,
  type WorkflowStore,
} from "./store";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";

export const WORKFLOW_WAIT_RESUME_KIND = "workflow_wait_resume";

const DEFAULT_LIMIT = 50;
const DEFAULT_LEASE_MS = 6 * 60_000;
const DEFAULT_RENEW_EVERY_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type WorkflowWakeStore = Pick<
  WorkflowStore,
  "dueWaitingSteps" | "resumeWaitingStep" | "failWaitingStep" | "failStep"
> &
  Partial<Pick<WorkflowStore, "failAutonomousRunningStep">>;

export type WorkflowWakeOptions = {
  store: WorkflowWakeStore;
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

export type WorkflowWakeReport = {
  considered: number;
  resumed: Array<{ workflowId: string; stepKey: string }>;
  skipped: Array<{ workflowId: string; stepKey: string; reason: string }>;
};

function wakeKey(workflowId: string, stepKey: string, waitUntil: Date): string {
  return `${workflowId}:${stepKey}:${waitUntil.toISOString()}`;
}

export async function offerDueWorkflowWaits(
  options: WorkflowWakeOptions,
): Promise<{ queued: number; already: number }> {
  const waits = await options.store.dueWaitingSteps(
    options.limit ?? DEFAULT_LIMIT,
  );
  let queued = 0;
  let already = 0;

  for (const wait of waits) {
    const outcome = await options.queue.offer({
      kind: WORKFLOW_WAIT_RESUME_KIND,
      key: wakeKey(wait.workflowId, wait.stepKey, wait.waitUntil),
      payload: {
        ownerUserId: wait.ownerUserId,
        agentId: wait.agentId,
        workflowId: wait.workflowId,
        stepKey: wait.stepKey,
        waitUntil: wait.waitUntil.toISOString(),
        attempts: wait.attempts,
      },
    });
    if (outcome === "queued") queued += 1;
    if (outcome === "already") already += 1;
  }

  return { queued, already };
}

export async function dispatchClaimedWorkflowWaits(
  options: WorkflowWakeOptions,
): Promise<WorkflowWakeReport> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claim({
    kind: WORKFLOW_WAIT_RESUME_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    maxAttempts,
  });

  const report: WorkflowWakeReport = {
    considered: claimed.length,
    resumed: [],
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
    const stamp =
      typeof item.payload.waitUntil === "string"
        ? new Date(item.payload.waitUntil)
        : null;
    const expectedAttempt =
      typeof item.payload.attempts === "number" &&
      Number.isInteger(item.payload.attempts) &&
      item.payload.attempts > 0
        ? item.payload.attempts
        : 0;

    if (
      !workflowId ||
      !stepKey ||
      !ownerUserId ||
      !agentId ||
      expectedAttempt === 0 ||
      !stamp ||
      Number.isNaN(stamp.getTime())
    ) {
      const reason = "workflow wake payload is incomplete or invalid";
      await options.queue.finish({
        kind: WORKFLOW_WAIT_RESUME_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({ workflowId, stepKey, reason });
      continue;
    }

    const renewed = await options.queue.renew({
      kind: WORKFLOW_WAIT_RESUME_KIND,
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

    let resumed = false;
    try {
      await options.store.resumeWaitingStep(
        { ownerUserId, agentId },
        workflowId,
        stepKey,
        stamp,
        expectedAttempt,
      );
      resumed = true;
      if (options.dispatch) {
        /*
         * A headless continuation can legitimately run for minutes. Keep the queue lease alive
         * for the whole model/browser turn instead of renewing only once before it starts: a
         * 30-second lease under a five-minute turn lets another replica claim the same exact wake
         * and repeat external side effects while the first Agent is still working.
         *
         * The lease is also six minutes by default (longer than the default headless-turn timeout)
         * so a briefly stalled event loop does not immediately hand the same workflow attempt away.
         * The heartbeat is still required for slow shutdowns and future longer turn budgets.
         */
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
                kind: WORKFLOW_WAIT_RESUME_KIND,
                key: item.key,
                owner: options.owner,
                leaseMs,
              })
              .catch(() => {});
          }, renewEveryMs);
          heartbeat.unref?.();

          // Ask the database immediately before the expensive turn too. If the lease was lost
          // between the first renewal and here, do not spend a model/browser run on work we no
          // longer own.
          const stillOurs = await options.queue.renew({
            kind: WORKFLOW_WAIT_RESUME_KIND,
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
            expectedAttempt,
          });
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
      }
      await options.queue.finish({
        kind: WORKFLOW_WAIT_RESUME_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.resumed.push({ workflowId, stepKey });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "workflow wait could not resume";

      if (error instanceof WorkflowCapacityError) {
        if (!options.queue.defer) {
          throw new Error(
            "work queue defer is unavailable for workflow capacity backoff",
          );
        }
        await options.queue.defer({
          kind: WORKFLOW_WAIT_RESUME_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
          reason,
        });
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      // A changed/cancelled/stale wait is final for this exact timestamp. The
      // store's compare-and-set refusal is what makes an old queue item harmless.
      if (
        /not due|changed after this wake|another attempt|does not exist|active workflow/i.test(
          reason,
        )
      ) {
        await options.queue.finish({
          kind: WORKFLOW_WAIT_RESUME_KIND,
          key: item.key,
          owner: options.owner,
        });
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      /*
       * Once resumeWaitingStep performed the exact waiting->running CAS, this queue item is the
       * only durable owner of the continuation attempt. If its final dispatch attempt fails and we
       * merely release it, claim() will refuse it forever because the work-item attempt cap has
       * already been reached, leaving the workflow step permanently "running".
       *
       * Close that hole fail-closed: mark only the exact workflow attempt failed, then finish the
       * exhausted queue item. Failures before the CAS stay retryable/stale-safe because the step is
       * still waiting and can be offered again with its exact wait stamp.
       */
      if (item.attempts >= maxAttempts) {
        try {
          const failure = `Autonomous wait continuation exhausted its retry budget: ${reason}`;
          if (resumed) {
            await options.store.failStep(
              { ownerUserId, agentId },
              workflowId,
              stepKey,
              failure,
              expectedAttempt,
            );
          } else {
            await options.store.failWaitingStep(
              { ownerUserId, agentId },
              workflowId,
              stepKey,
              stamp,
              expectedAttempt,
              failure,
            );
          }
        } finally {
          await options.queue.finish({
            kind: WORKFLOW_WAIT_RESUME_KIND,
            key: item.key,
            owner: options.owner,
          });
        }
        report.skipped.push({ workflowId, stepKey, reason });
        continue;
      }

      await options.queue.release({
        kind: WORKFLOW_WAIT_RESUME_KIND,
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

export async function reconcileExhaustedWorkflowWaits(
  options: WorkflowWakeOptions,
): Promise<WorkflowWakeReport> {
  if (!options.queue.claimExhausted || !options.store.failAutonomousRunningStep) {
    throw new Error(
      "exhausted workflow wait recovery capabilities are unavailable",
    );
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claimExhausted({
    kind: WORKFLOW_WAIT_RESUME_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    maxAttempts,
  });
  const report: WorkflowWakeReport = {
    considered: claimed.length,
    resumed: [],
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
    const stamp =
      typeof item.payload.waitUntil === "string"
        ? new Date(item.payload.waitUntil)
        : null;
    const expectedAttempt =
      typeof item.payload.attempts === "number" &&
      Number.isInteger(item.payload.attempts) &&
      item.payload.attempts > 0
        ? item.payload.attempts
        : 0;

    if (
      !workflowId ||
      !stepKey ||
      !ownerUserId ||
      !agentId ||
      expectedAttempt === 0 ||
      !stamp ||
      Number.isNaN(stamp.getTime())
    ) {
      await options.queue.finish({
        kind: WORKFLOW_WAIT_RESUME_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({
        workflowId,
        stepKey,
        reason: "exhausted workflow wait payload is invalid",
      });
      continue;
    }

    const identity = { ownerUserId, agentId };
    const failure =
      "Autonomous wait continuation exhausted its retry budget after a worker interruption.";
    try {
      try {
        await options.store.failAutonomousRunningStep(
          identity,
          workflowId,
          stepKey,
          stamp,
          expectedAttempt,
          failure,
        );
      } catch (error) {
        if (!(error instanceof WorkflowRefusedError)) throw error;
        await options.store.failWaitingStep(
          identity,
          workflowId,
          stepKey,
          stamp,
          expectedAttempt,
          failure,
        );
      }
      await options.queue.finish({
        kind: WORKFLOW_WAIT_RESUME_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.skipped.push({ workflowId, stepKey, reason: failure });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "exhausted wait cleanup failed";
      if (error instanceof WorkflowRefusedError) {
        await options.queue.finish({
          kind: WORKFLOW_WAIT_RESUME_KIND,
          key: item.key,
          owner: options.owner,
        });
      } else {
        await options.queue.release({
          kind: WORKFLOW_WAIT_RESUME_KIND,
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

export async function sweepWorkflowWaits(
  options: WorkflowWakeOptions,
): Promise<WorkflowWakeReport & { queued: number; already: number }> {
  const offered = await offerDueWorkflowWaits(options);
  const dispatched = await dispatchClaimedWorkflowWaits(options);
  const recovered = await reconcileExhaustedWorkflowWaits(options);
  return {
    ...offered,
    considered: dispatched.considered + recovered.considered,
    resumed: dispatched.resumed,
    skipped: [...dispatched.skipped, ...recovered.skipped],
  };
}

export const WORKFLOW_WAKE_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
