/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const routineRunStatus = pgEnum("routine_run_status", [
  "succeeded",
  "failed",
  "skipped",
]);

export const routineScheduleKind = pgEnum("routine_schedule_kind", [
  "recurring",
  "once",
]);

/**
 * A standing instruction one person gave one Bot, on a schedule.
 *
 * Owned rows all the way down: the owner is who the headless turn runs as, so the routine can do
 * exactly what its owner could do in chat and nothing more. The channel is where the reply lands.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key. Channels soft-delete (`channels.deletedAt`), and a routine pointing at a
     * deleted channel must survive to be shown as broken rather than vanish in a cascade.
     */
    channelId: text("channel_id").notNull(),
    instruction: text("instruction").notNull(),
    /**
     * Recurring routines advance through cron. One-time wakes keep their exact `next_run_at` and are
     * consumed by the queue worker before dispatch, so a restart cannot turn one wait into a loop.
     */
    scheduleKind: routineScheduleKind("schedule_kind")
      .notNull()
      .default("recurring"),
    /** Five-field cron for recurring rows. One-time rows keep an observability-only UTC expression. */
    cron: text("cron").notNull(),
    /** IANA zone the cron is read in. UTC when the person never said otherwise. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** The sweep's read target. Recomputed on every write and CAS-advanced by the sweep. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /**
     * The last occurrence stamp the sweep advanced past — fired OR silently drained as stale.
     * Not "when this last ran": the run history lives in routine_runs, and everything a person
     * sees reads that table. This is the scheduler's own bookmark, kept because a CAS needs the
     * value it compared against recorded somewhere a human can inspect when a clock looks wrong.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
    /** Owner-scoped reads and writes: listFor, countEnabled, and the users cascade all hit this. */
    index("routines_by_owner_idx").on(table.ownerUserId, table.enabled),
  ],
);

export const routineSweeps = pgTable("routine_sweeps", {
  id: text("id").primaryKey(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull().defaultNow(),
  owner: text("owner"),
});

/** One row per firing, which is what the page's "last ran" and the fatigue rule read. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Null means the firing is still in flight; only a finished run has succeeded/failed/skipped. */
    status: routineRunStatus("status"),
    /** The refusal or the throw, capped like audit payloads. Never shown raw to a person. */
    error: text("error"),
  },
  (table) => [
    index("routine_runs_by_routine_idx").on(table.routineId, table.startedAt),
  ],
);

export const workflowRunStatus = pgEnum("workflow_run_status", [
  "active",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);

export const workflowStepStatus = pgEnum("workflow_step_status", [
  "blocked",
  "ready",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

export const workflowAssetDirection = pgEnum("workflow_asset_direction", [
  "input",
  "output",
]);

export const workflowAssetMediaKind = pgEnum("workflow_asset_media_kind", [
  "image",
  "video",
  "audio",
  "file",
  "text",
]);

/**
 * A durable multi-step plan owned by one person and one Bot.
 *
 * The Bot id is part of the authority boundary, not only metadata: workflow-store reads and
 * transitions filter by both owner and Bot so two coworkers belonging to the same person cannot
 * mutate each other's pending work.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Channels soft-delete, so a broken destination must remain inspectable rather than cascade. */
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    status: workflowRunStatus("status").notNull().default("active"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("workflow_runs_owner_status_idx").on(table.ownerUserId, table.status),
    index("workflow_runs_agent_status_idx").on(table.agentId, table.status),
  ],
);

/**
 * One resumable unit inside a workflow.
 *
 * Dependencies are local step keys. The store only accepts references to earlier steps in the same
 * create call, which makes the graph acyclic by construction and prevents cross-workflow references.
 */
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    instruction: text("instruction").notNull(),
    dependsOn: text("depends_on").array().notNull().default([]),
    status: workflowStepStatus("status").notNull().default("blocked"),
    attempts: integer("attempts").notNull().default(0),
    /** Which external/model provider owns a pending wait, when there is one. Never a credential. */
    provider: text("provider"),
    /** Exact durable wake target for a waiting step. */
    waitUntil: timestamp("wait_until", { withTimezone: true }),
    /** Exact wait stamp whose wake most recently moved this attempt back to running. */
    resumedFromWaitUntil: timestamp("resumed_from_wait_until", {
      withTimezone: true,
    }),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("workflow_steps_workflow_key_idx").on(
      table.workflowId,
      table.key,
    ),
    index("workflow_steps_workflow_position_idx").on(
      table.workflowId,
      table.position,
    ),
    index("workflow_steps_status_wait_idx").on(table.status, table.waitUntil),
  ],
);

/**
 * Durable metadata for files/media used or produced by one workflow step.
 *
 * The ref is deliberately metadata only. Resolving a workspace path or attachment still goes
 * through the existing Files/attachment permission boundaries; this table grants no file access.
 */
export const workflowAssets = pgTable(
  "workflow_assets",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    direction: workflowAssetDirection("direction").notNull(),
    mediaKind: workflowAssetMediaKind("media_kind").notNull(),
    ref: text("ref").notNull(),
    label: text("label"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("workflow_assets_step_ref_idx").on(
      table.workflowId,
      table.stepKey,
      table.direction,
      table.ref,
    ),
    index("workflow_assets_workflow_step_idx").on(
      table.workflowId,
      table.stepKey,
    ),
  ],
);
