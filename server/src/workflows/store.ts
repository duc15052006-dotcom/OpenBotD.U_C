import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  attachments,
  channelAgents,
  channelMemberships,
  channels,
  workflowAssets,
  workflowRuns,
  workflowSteps,
} from "../db/schema";

export const MAX_WORKFLOW_STEPS = 100;
export const MAX_WORKFLOW_TITLE_CODE_POINTS = 160;
export const MAX_WORKFLOW_INSTRUCTION_CODE_POINTS = 4000;
export const MAX_WORKFLOW_FAILURE_CODE_POINTS = 500;
export const MAX_WORKFLOW_PROVIDER_CODE_POINTS = 120;
export const MAX_WORKFLOW_ASSET_REF_CODE_POINTS = 512;
export const MAX_WORKFLOW_ASSET_LABEL_CODE_POINTS = 200;

const ACTIVE_STEP_STATUSES = [
  "blocked",
  "ready",
  "running",
  "waiting",
] as const;

export type WorkflowStatus =
  | "active"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "blocked"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowIdentity = {
  ownerUserId: string;
  agentId: string;
};

export type WorkflowStepInput = {
  key: string;
  instruction: string;
  dependsOn?: string[];
};

export type WorkflowInput = WorkflowIdentity & {
  channelId: string;
  title: string;
  steps: WorkflowStepInput[];
};

export type WorkflowStep = {
  id: string;
  workflowId: string;
  key: string;
  position: number;
  instruction: string;
  dependsOn: string[];
  status: WorkflowStepStatus;
  attempts: number;
  provider: string | null;
  waitUntil: Date | null;
  failureReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowRun = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  title: string;
  status: WorkflowStatus;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowPlan = WorkflowRun & { steps: WorkflowStep[] };

export type WorkflowAssetDirection = "input" | "output";
export type WorkflowAssetMediaKind =
  | "image"
  | "video"
  | "audio"
  | "file"
  | "text";

export type WorkflowAsset = {
  id: string;
  workflowId: string;
  stepKey: string;
  direction: WorkflowAssetDirection;
  mediaKind: WorkflowAssetMediaKind;
  ref: string;
  label: string | null;
  createdAt: Date;
};

export type WorkflowAssetInput = {
  direction: WorkflowAssetDirection;
  mediaKind: WorkflowAssetMediaKind;
  ref: string;
  label?: string;
};

export type DueWorkflowWait = WorkflowIdentity & {
  workflowId: string;
  stepKey: string;
  waitUntil: Date;
};

export class WorkflowNotFoundError extends Error {
  constructor() {
    super("That workflow does not exist.");
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRefusedError";
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Handle = Database | Transaction;

type WorkflowRunRow = typeof workflowRuns.$inferSelect;
type WorkflowStepRow = typeof workflowSteps.$inferSelect;
type WorkflowAssetRow = typeof workflowAssets.$inferSelect;

function textWithin(
  value: string,
  label: string,
  maxCodePoints: number,
): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkflowRefusedError(`${label} cannot be empty.`);
  if (Array.from(trimmed).length > maxCodePoints) {
    throw new WorkflowRefusedError(
      `${label} can be at most ${maxCodePoints} characters.`,
    );
  }
  return trimmed;
}

function stepKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) {
    throw new WorkflowRefusedError(
      "A workflow step key must be 1-64 letters, numbers, dots, underscores or dashes.",
    );
  }
  return key;
}

function toRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    channelId: row.channelId,
    title: row.title,
    status: row.status,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStep(row: WorkflowStepRow): WorkflowStep {
  return {
    id: row.id,
    workflowId: row.workflowId,
    key: row.key,
    position: row.position,
    instruction: row.instruction,
    dependsOn: row.dependsOn,
    status: row.status,
    attempts: row.attempts,
    provider: row.provider,
    waitUntil: row.waitUntil,
    failureReason: row.failureReason,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAsset(row: WorkflowAssetRow): WorkflowAsset {
  return {
    id: row.id,
    workflowId: row.workflowId,
    stepKey: row.stepKey,
    direction: row.direction,
    mediaKind: row.mediaKind,
    ref: row.ref,
    label: row.label,
    createdAt: row.createdAt,
  };
}

const ATTACHMENT_REF =
  /^attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function safeAssetRef(value: string):
  | { kind: "attachment"; value: string; attachmentId: string }
  | { kind: "workspace"; value: string } {
  const ref = textWithin(
    value,
    "A workflow asset reference",
    MAX_WORKFLOW_ASSET_REF_CODE_POINTS,
  );
  const attachment = ref.match(ATTACHMENT_REF);
  if (attachment?.[1]) {
    return { kind: "attachment", value: ref, attachmentId: attachment[1] };
  }
  if (!ref.startsWith("workspace:")) {
    throw new WorkflowRefusedError(
      "A workflow asset reference must be attachment:<uuid> or workspace:<relative-path>.",
    );
  }
  const path = ref.slice("workspace:".length);
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new WorkflowRefusedError(
      "A workspace asset reference must be a safe relative path with no dot segments.",
    );
  }
  return { kind: "workspace", value: ref };
}

function terminal(status: WorkflowStatus): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

export type WorkflowStore = {
  create(input: WorkflowInput): Promise<WorkflowPlan>;
  get(identity: WorkflowIdentity, id: string): Promise<WorkflowPlan | null>;
  listFor(identity: WorkflowIdentity): Promise<WorkflowRun[]>;
  pause(identity: WorkflowIdentity, id: string): Promise<WorkflowPlan>;
  resume(identity: WorkflowIdentity, id: string): Promise<WorkflowPlan>;
  cancel(identity: WorkflowIdentity, id: string): Promise<WorkflowPlan>;
  fail(identity: WorkflowIdentity, id: string): Promise<WorkflowPlan>;
  startStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
  ): Promise<WorkflowStep>;
  waitStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
    input: { waitUntil: Date; provider?: string },
  ): Promise<WorkflowStep>;
  resumeWaitingStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
    expectedWaitUntil: Date,
  ): Promise<WorkflowStep>;
  completeStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
  ): Promise<WorkflowPlan>;
  failStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
    reason: string,
  ): Promise<WorkflowStep>;
  retryStep(
    identity: WorkflowIdentity,
    id: string,
    key: string,
  ): Promise<WorkflowStep>;
  dueWaitingSteps(limit: number): Promise<DueWorkflowWait[]>;
  addAsset(
    identity: WorkflowIdentity,
    id: string,
    key: string,
    input: WorkflowAssetInput,
  ): Promise<WorkflowAsset>;
  listAssets(
    identity: WorkflowIdentity,
    id: string,
    key?: string,
  ): Promise<WorkflowAsset[]>;
  removeAsset(
    identity: WorkflowIdentity,
    id: string,
    assetId: string,
  ): Promise<void>;
};

export function createWorkflowStore(database: Database): WorkflowStore {
  async function loadOwned(
    handle: Handle,
    identity: WorkflowIdentity,
    id: string,
  ): Promise<WorkflowRunRow> {
    const [row] = await handle
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.id, id),
          eq(workflowRuns.ownerUserId, identity.ownerUserId),
          eq(workflowRuns.agentId, identity.agentId),
        ),
      )
      .limit(1);
    if (!row) throw new WorkflowNotFoundError();
    return row;
  }

  async function lockWorkflow(
    transaction: Transaction,
    id: string,
  ): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`workflow-${id}`}))`,
    );
  }

  async function channelAllowed(input: WorkflowInput): Promise<void> {
    const [row] = await database
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, input.ownerUserId),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, input.agentId),
        ),
      )
      .where(and(eq(channels.id, input.channelId), isNull(channels.deletedAt)))
      .limit(1);
    if (!row) {
      throw new WorkflowRefusedError(
        "That channel is not shared by this person and this Bot.",
      );
    }
  }

  function preparedSteps(input: WorkflowStepInput[]) {
    if (input.length === 0) {
      throw new WorkflowRefusedError("A workflow needs at least one step.");
    }
    if (input.length > MAX_WORKFLOW_STEPS) {
      throw new WorkflowRefusedError(
        `A workflow can have at most ${MAX_WORKFLOW_STEPS} steps.`,
      );
    }

    const seen = new Set<string>();
    return input.map((raw, position) => {
      const key = stepKey(raw.key);
      if (seen.has(key)) {
        throw new WorkflowRefusedError(
          `Workflow step key "${key}" is duplicated.`,
        );
      }
      const dependencies = [...new Set(raw.dependsOn ?? [])].map(stepKey);
      for (const dependency of dependencies) {
        if (!seen.has(dependency)) {
          throw new WorkflowRefusedError(
            `Workflow step "${key}" depends on "${dependency}", which must be an earlier step in the same workflow.`,
          );
        }
      }
      seen.add(key);
      return {
        key,
        position,
        instruction: textWithin(
          raw.instruction,
          "A workflow step instruction",
          MAX_WORKFLOW_INSTRUCTION_CODE_POINTS,
        ),
        dependsOn: dependencies,
        status:
          dependencies.length === 0 ? ("ready" as const) : ("blocked" as const),
      };
    });
  }

  async function planFor(
    identity: WorkflowIdentity,
    id: string,
  ): Promise<WorkflowPlan | null> {
    const [run] = await database
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.id, id),
          eq(workflowRuns.ownerUserId, identity.ownerUserId),
          eq(workflowRuns.agentId, identity.agentId),
        ),
      )
      .limit(1);
    if (!run) return null;
    const steps = await database
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, id))
      .orderBy(asc(workflowSteps.position), asc(workflowSteps.id));
    return { ...toRun(run), steps: steps.map(toStep) };
  }

  async function transitionRun(
    identity: WorkflowIdentity,
    id: string,
    from: WorkflowStatus,
    to: WorkflowStatus,
  ): Promise<WorkflowPlan> {
    await database.transaction(async (transaction) => {
      await lockWorkflow(transaction, id);
      await loadOwned(transaction, identity, id);
      const changed = await transaction
        .update(workflowRuns)
        .set({ status: to, updatedAt: sql`now()` })
        .where(
          and(
            eq(workflowRuns.id, id),
            eq(workflowRuns.ownerUserId, identity.ownerUserId),
            eq(workflowRuns.agentId, identity.agentId),
            eq(workflowRuns.status, from),
          ),
        )
        .returning({ id: workflowRuns.id });
      if (changed.length === 0) {
        throw new WorkflowRefusedError(
          `That workflow is not ${from}, so it cannot become ${to}.`,
        );
      }
    });
    return (await planFor(identity, id)) as WorkflowPlan;
  }

  async function endRun(
    identity: WorkflowIdentity,
    id: string,
    status: "failed" | "cancelled",
  ): Promise<WorkflowPlan> {
    await database.transaction(async (transaction) => {
      await lockWorkflow(transaction, id);
      const run = await loadOwned(transaction, identity, id);
      if (terminal(run.status)) {
        if (run.status === status) return;
        throw new WorkflowRefusedError("That workflow has already finished.");
      }
      await transaction
        .update(workflowRuns)
        .set({
          status,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(workflowRuns.id, id));
      await transaction
        .update(workflowSteps)
        .set({
          status: "cancelled",
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workflowSteps.workflowId, id),
            inArray(workflowSteps.status, ACTIVE_STEP_STATUSES),
          ),
        );
    });
    return (await planFor(identity, id)) as WorkflowPlan;
  }

  async function ensureAssetStep(
    transaction: Transaction,
    workflowId: string,
    key: string,
  ): Promise<string> {
    const wantedKey = stepKey(key);
    const [row] = await transaction
      .select({ key: workflowSteps.key })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.workflowId, workflowId),
          eq(workflowSteps.key, wantedKey),
        ),
      )
      .limit(1);
    if (!row) {
      throw new WorkflowRefusedError(
        "That workflow step does not exist for this workflow.",
      );
    }
    return wantedKey;
  }

  async function attachmentVisibleToWorkflow(
    transaction: Transaction,
    run: WorkflowRunRow,
    identity: WorkflowIdentity,
    attachmentId: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(
        channels,
        and(
          eq(channels.id, attachments.channelId),
          isNull(channels.deletedAt),
        ),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, attachments.channelId),
          eq(channelMemberships.userId, identity.ownerUserId),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, attachments.channelId),
          eq(channelAgents.agentId, identity.agentId),
        ),
      )
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.channelId, run.channelId),
          or(
            isNotNull(attachments.attachedAt),
            eq(attachments.uploadedBy, identity.ownerUserId),
          ),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  return {
    async create(input) {
      const title = textWithin(
        input.title,
        "A workflow title",
        MAX_WORKFLOW_TITLE_CODE_POINTS,
      );
      const steps = preparedSteps(input.steps);
      await channelAllowed(input);

      const id = `workflow_${crypto.randomUUID()}`;
      await database.transaction(async (transaction) => {
        await transaction.insert(workflowRuns).values({
          id,
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          channelId: input.channelId,
          title,
        });
        await transaction.insert(workflowSteps).values(
          steps.map((step) => ({
            id: `workflow_step_${crypto.randomUUID()}`,
            workflowId: id,
            ...step,
          })),
        );
      });
      return (await planFor(input, id)) as WorkflowPlan;
    },

    get: planFor,

    async listFor(identity) {
      const rows = await database
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.ownerUserId, identity.ownerUserId),
            eq(workflowRuns.agentId, identity.agentId),
          ),
        )
        .orderBy(asc(workflowRuns.createdAt), asc(workflowRuns.id));
      return rows.map(toRun);
    },

    pause(identity, id) {
      return transitionRun(identity, id, "active", "paused");
    },

    resume(identity, id) {
      return transitionRun(identity, id, "paused", "active");
    },

    cancel(identity, id) {
      return endRun(identity, id, "cancelled");
    },

    fail(identity, id) {
      return endRun(identity, id, "failed");
    },

    async startStep(identity, id, key) {
      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (run.status !== "active") {
          throw new WorkflowRefusedError(
            "Only an active workflow can start a step.",
          );
        }
        const [row] = await transaction
          .update(workflowSteps)
          .set({
            status: "running",
            attempts: sql`${workflowSteps.attempts} + 1`,
            startedAt: sql`now()`,
            finishedAt: null,
            failureReason: null,
            waitUntil: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              eq(workflowSteps.key, stepKey(key)),
              eq(workflowSteps.status, "ready"),
            ),
          )
          .returning();
        if (!row) {
          throw new WorkflowRefusedError(
            "That workflow step is not ready to start.",
          );
        }
        return toStep(row);
      });
    },

    async waitStep(identity, id, key, input) {
      if (
        !(input.waitUntil instanceof Date) ||
        Number.isNaN(input.waitUntil.getTime()) ||
        input.waitUntil.getTime() <= Date.now()
      ) {
        throw new WorkflowRefusedError(
          "A waiting workflow step needs a future wake time.",
        );
      }
      const provider = input.provider
        ? textWithin(
            input.provider,
            "A workflow provider",
            MAX_WORKFLOW_PROVIDER_CODE_POINTS,
          )
        : null;
      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (run.status !== "active") {
          throw new WorkflowRefusedError(
            "Only an active workflow can enter a wait.",
          );
        }
        const [row] = await transaction
          .update(workflowSteps)
          .set({
            status: "waiting",
            provider,
            waitUntil: input.waitUntil,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              eq(workflowSteps.key, stepKey(key)),
              eq(workflowSteps.status, "running"),
            ),
          )
          .returning();
        if (!row) {
          throw new WorkflowRefusedError(
            "Only a running workflow step can enter a wait.",
          );
        }
        return toStep(row);
      });
    },

    async resumeWaitingStep(identity, id, key, expectedWaitUntil) {
      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (run.status !== "active") {
          throw new WorkflowRefusedError(
            "Only an active workflow can resume a waiting step.",
          );
        }
        const [row] = await transaction
          .update(workflowSteps)
          .set({
            status: "running",
            waitUntil: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              eq(workflowSteps.key, stepKey(key)),
              eq(workflowSteps.status, "waiting"),
              eq(workflowSteps.waitUntil, expectedWaitUntil),
              lte(workflowSteps.waitUntil, sql`now()`),
            ),
          )
          .returning();
        if (!row) {
          throw new WorkflowRefusedError(
            "That wait is not due, or it was changed after this wake was scheduled.",
          );
        }
        return toStep(row);
      });
    },

    async completeStep(identity, id, key) {
      await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (terminal(run.status)) {
          throw new WorkflowRefusedError("That workflow has already finished.");
        }

        const [completed] = await transaction
          .update(workflowSteps)
          .set({
            status: "succeeded",
            finishedAt: sql`now()`,
            waitUntil: null,
            failureReason: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              eq(workflowSteps.key, stepKey(key)),
              eq(workflowSteps.status, "running"),
            ),
          )
          .returning({ id: workflowSteps.id });
        if (!completed) {
          throw new WorkflowRefusedError(
            "Only a running workflow step can complete.",
          );
        }

        const rows = await transaction
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, id))
          .orderBy(asc(workflowSteps.position));
        const byKey = new Map(rows.map((row) => [row.key, row.status]));

        for (const step of rows) {
          if (step.status !== "blocked") continue;
          if (
            step.dependsOn.every(
              (dependency) => byKey.get(dependency) === "succeeded",
            )
          ) {
            await transaction
              .update(workflowSteps)
              .set({ status: "ready", updatedAt: sql`now()` })
              .where(
                and(
                  eq(workflowSteps.id, step.id),
                  eq(workflowSteps.status, "blocked"),
                ),
              );
          }
        }

        const remaining = await transaction
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              inArray(workflowSteps.status, [
                "blocked",
                "ready",
                "running",
                "waiting",
                "failed",
              ]),
            ),
          )
          .limit(1);
        if (remaining.length === 0) {
          await transaction
            .update(workflowRuns)
            .set({
              status: "succeeded",
              finishedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(workflowRuns.id, id));
        }
      });
      return (await planFor(identity, id)) as WorkflowPlan;
    },

    async failStep(identity, id, key, reason) {
      const failureReason = textWithin(
        reason,
        "A workflow failure reason",
        MAX_WORKFLOW_FAILURE_CODE_POINTS,
      );
      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (terminal(run.status)) {
          throw new WorkflowRefusedError("That workflow has already finished.");
        }
        const [row] = await transaction
          .update(workflowSteps)
          .set({
            status: "failed",
            failureReason,
            finishedAt: sql`now()`,
            waitUntil: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.workflowId, id),
              eq(workflowSteps.key, stepKey(key)),
              eq(workflowSteps.status, "running"),
            ),
          )
          .returning();
        if (!row) {
          throw new WorkflowRefusedError(
            "Only a running workflow step can fail.",
          );
        }
        return toStep(row);
      });
    },

    async retryStep(identity, id, key) {
      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        if (terminal(run.status)) {
          throw new WorkflowRefusedError("That workflow has already finished.");
        }
        const wantedKey = stepKey(key);
        const rows = await transaction
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowId, id));
        const step = rows.find((candidate) => candidate.key === wantedKey);
        if (step?.status !== "failed") {
          throw new WorkflowRefusedError(
            "Only a failed workflow step can be retried.",
          );
        }
        const byKey = new Map(rows.map((row) => [row.key, row.status]));
        if (
          !step.dependsOn.every(
            (dependency) => byKey.get(dependency) === "succeeded",
          )
        ) {
          throw new WorkflowRefusedError(
            "That workflow step is still blocked by an unfinished dependency.",
          );
        }
        const [row] = await transaction
          .update(workflowSteps)
          .set({
            status: "ready",
            failureReason: null,
            finishedAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(workflowSteps.id, step.id),
              eq(workflowSteps.status, "failed"),
            ),
          )
          .returning();
        if (!row) {
          throw new WorkflowRefusedError(
            "That workflow step changed before it could be retried.",
          );
        }
        return toStep(row);
      });
    },

    async addAsset(identity, id, key, input) {
      const ref = safeAssetRef(input.ref);
      if (!["input", "output"].includes(input.direction)) {
        throw new WorkflowRefusedError(
          "A workflow asset direction must be input or output.",
        );
      }
      if (
        !["image", "video", "audio", "file", "text"].includes(input.mediaKind)
      ) {
        throw new WorkflowRefusedError(
          "A workflow asset media kind is not supported.",
        );
      }
      const label = input.label
        ? textWithin(
            input.label,
            "A workflow asset label",
            MAX_WORKFLOW_ASSET_LABEL_CODE_POINTS,
          )
        : null;

      return await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        const run = await loadOwned(transaction, identity, id);
        const wantedKey = await ensureAssetStep(transaction, id, key);
        if (
          ref.kind === "attachment" &&
          !(await attachmentVisibleToWorkflow(
            transaction,
            run,
            identity,
            ref.attachmentId,
          ))
        ) {
          throw new WorkflowRefusedError(
            "That attachment is not available in this workflow's channel.",
          );
        }
        const [row] = await transaction
          .insert(workflowAssets)
          .values({
            id: `workflow_asset_${crypto.randomUUID()}`,
            workflowId: id,
            stepKey: wantedKey,
            direction: input.direction,
            mediaKind: input.mediaKind,
            ref: ref.value,
            label,
          })
          .onConflictDoNothing()
          .returning();
        if (row) return toAsset(row);

        const [existing] = await transaction
          .select()
          .from(workflowAssets)
          .where(
            and(
              eq(workflowAssets.workflowId, id),
              eq(workflowAssets.stepKey, wantedKey),
              eq(workflowAssets.direction, input.direction),
              eq(workflowAssets.ref, ref.value),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new Error("workflow asset insert conflicted without a row");
        }
        return toAsset(existing);
      });
    },

    async listAssets(identity, id, key) {
      await loadOwned(database, identity, id);
      const wantedKey = key === undefined ? undefined : stepKey(key);
      const rows = await database
        .select()
        .from(workflowAssets)
        .where(
          wantedKey === undefined
            ? eq(workflowAssets.workflowId, id)
            : and(
                eq(workflowAssets.workflowId, id),
                eq(workflowAssets.stepKey, wantedKey),
              ),
        )
        .orderBy(asc(workflowAssets.createdAt), asc(workflowAssets.id));
      return rows.map(toAsset);
    },

    async removeAsset(identity, id, assetId) {
      await database.transaction(async (transaction) => {
        await lockWorkflow(transaction, id);
        await loadOwned(transaction, identity, id);
        const deleted = await transaction
          .delete(workflowAssets)
          .where(
            and(
              eq(workflowAssets.id, assetId),
              eq(workflowAssets.workflowId, id),
            ),
          )
          .returning({ id: workflowAssets.id });
        if (deleted.length === 0) {
          throw new WorkflowRefusedError(
            "That workflow asset does not exist for this workflow.",
          );
        }
      });
    },

    async dueWaitingSteps(limit) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
        throw new WorkflowRefusedError(
          "A due-wait scan limit must be between 1 and 500.",
        );
      }
      const rows = await database
        .select({
          ownerUserId: workflowRuns.ownerUserId,
          agentId: workflowRuns.agentId,
          workflowId: workflowRuns.id,
          stepKey: workflowSteps.key,
          waitUntil: workflowSteps.waitUntil,
        })
        .from(workflowSteps)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.workflowId))
        .where(
          and(
            eq(workflowRuns.status, "active"),
            eq(workflowSteps.status, "waiting"),
            isNotNull(workflowSteps.waitUntil),
            lte(workflowSteps.waitUntil, sql`now()`),
          ),
        )
        .orderBy(asc(workflowSteps.waitUntil), asc(workflowSteps.id))
        .limit(limit);
      return rows.flatMap((row) =>
        row.waitUntil
          ? [
              {
                ownerUserId: row.ownerUserId,
                agentId: row.agentId,
                workflowId: row.workflowId,
                stepKey: row.stepKey,
                waitUntil: row.waitUntil,
              },
            ]
          : [],
      );
    },
  };
}
