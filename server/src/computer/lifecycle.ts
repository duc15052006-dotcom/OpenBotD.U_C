import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import type { ComputerLifecycleState } from "./schema";

export const COMPUTER_LIFECYCLE_EVENTS = [
  "computer.started",
  "computer.woke",
  "computer.restarted",
  "computer.slept",
  "computer.stopped",
  "computer.reset",
] as const;

export type ComputerLifecycleEvent = (typeof COMPUTER_LIFECYCLE_EVENTS)[number];

export type ComputerLifecycleReader = {
  latest(botIds: string[]): Promise<Map<string, ComputerLifecycleEvent>>;
};

/**
 * One lifecycle label for the fleet surface.
 *
 * A running container with no resident browser is idle: its durable profile remains mounted and the
 * next browser action can relaunch Chromium without recreating the Computer. A stopped container is
 * called sleeping only when the durable audit trail says the idle culler put it there; an explicit
 * Stop remains stopped, so the UI never pretends a person's action was automatic power saving.
 */
export function computerLifecycleState(input: {
  running: boolean;
  browserRunning?: boolean;
  latestEvent?: ComputerLifecycleEvent;
}): ComputerLifecycleState {
  if (input.running) {
    return input.browserRunning === false ? "idle" : "running";
  }
  return input.latestEvent === "computer.slept" ? "sleeping" : "stopped";
}

/**
 * Read the newest lifecycle event for every requested Bot in one database query.
 *
 * Fleet pages can contain many stopped profiles. Querying the audit reader once per row turns one
 * refresh into an N+1 burst; reading the bounded lifecycle event family together keeps the refresh
 * cost proportional to the actual number of lifecycle changes instead.
 */
export function createComputerLifecycleReader(
  database: Database,
): ComputerLifecycleReader {
  return {
    latest: async (botIds) => {
      const unique = [...new Set(botIds.filter(Boolean))];
      if (unique.length === 0) return new Map();

      const rows = await database
        .select({
          targetId: auditEvents.targetId,
          eventType: auditEvents.eventType,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "computer"),
            inArray(auditEvents.targetId, unique),
            inArray(
              auditEvents.eventType,
              COMPUTER_LIFECYCLE_EVENTS as unknown as string[],
            ),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));

      const latest = new Map<string, ComputerLifecycleEvent>();
      for (const row of rows) {
        if (
          !row.targetId ||
          latest.has(row.targetId) ||
          !COMPUTER_LIFECYCLE_EVENTS.includes(
            row.eventType as ComputerLifecycleEvent,
          )
        ) {
          continue;
        }
        latest.set(row.targetId, row.eventType as ComputerLifecycleEvent);
      }
      return latest;
    },
  };
}
