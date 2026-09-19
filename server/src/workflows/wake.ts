import type { WorkflowStore } from "./store";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";

export const WORKFLOW_WAIT_RESUME_KIND = "workflow_wait_resume";

const DEFAULT_LIMIT = 50;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

type WorkflowWakeStore = Pick<
  WorkflowStore,
  "dueWaitingSteps" | "resumeWaitingStep"
>;

export type WorkflowWakeOptions = {
  store: WorkflowWakeStore;
  queue: WorkQueue;
  owner: string;
  limit?: number;
  leaseMs?: number;
  retryDelayMs?: number;
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
  const claimed = await options.queue.claim({
    kind: WORKFLOW_WAIT_RESUME_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
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

    if (
      !workflowId ||
      !stepKey ||
      !ownerUserId ||
      !agentId ||
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

    try {
      await options.store.resumeWaitingStep(
        { ownerUserId, agentId },
        workflowId,
        stepKey,
        stamp,
      );
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

      // A changed/cancelled/stale wait is final for this exact timestamp. The
      // store's compare-and-set refusal is what makes an old queue item harmless.
      if (
        /not due|changed after this wake|does not exist|active workflow/i.test(
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

export async function sweepWorkflowWaits(
  options: WorkflowWakeOptions,
): Promise<WorkflowWakeReport & { queued: number; already: number }> {
  const offered = await offerDueWorkflowWaits(options);
  const dispatched = await dispatchClaimedWorkflowWaits(options);
  return { ...offered, ...dispatched };
}

export const WORKFLOW_WAKE_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
