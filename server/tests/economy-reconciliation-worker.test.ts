import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import type { PaymentAdapterResolver } from "../src/economy/payment-adapter-resolver";
import type {
  PaymentReceiptReconciliationSource,
  PaymentReconciliationCursor,
} from "../src/economy/reconciliation";
import {
  PAYMENT_RECONCILIATION_WORK_KIND,
  reconciliationHourKey,
  sweepPaymentReconciliation,
  type PaymentReconciliationCheckpointStore,
} from "../src/economy/reconciliation-worker";
import type { WorkItem, WorkQueue } from "../src/work/queue";

function sharedQueue(): WorkQueue {
  let item:
    | {
        kind: string;
        key: string;
        payload: Record<string, unknown>;
        finished: boolean;
        owner?: string;
        attempts: number;
      }
    | undefined;

  return {
    offer: async ({ kind, key, payload = {} }) => {
      if (item?.kind === kind && item.key === key) return "already";
      item = { kind, key, payload, finished: false, attempts: 0 };
      return "queued";
    },
    claim: async ({ kind, owner }) => {
      if (!item || item.kind !== kind || item.finished || item.owner) return [];
      item.owner = owner;
      item.attempts += 1;
      const claimed: WorkItem = {
        kind: item.kind,
        key: item.key,
        payload: item.payload,
        attempts: item.attempts,
      };
      return [claimed];
    },
    renew: async ({ kind, key, owner }) =>
      Boolean(
        item &&
          item.kind === kind &&
          item.key === key &&
          item.owner === owner &&
          !item.finished,
      ),
    finish: async ({ kind, key, owner }) => {
      if (
        !item ||
        item.kind !== kind ||
        item.key !== key ||
        item.owner !== owner ||
        item.finished
      ) {
        return false;
      }
      item.finished = true;
      item.owner = undefined;
      return true;
    },
    release: async ({ kind, key, owner }) => {
      if (
        !item ||
        item.kind !== kind ||
        item.key !== key ||
        item.owner !== owner ||
        item.finished
      ) {
        return false;
      }
      item.owner = undefined;
      return true;
    },
    purge: async () => 0,
  };
}

const auditStore: AuditStore = { insert: async () => {} };

const adapterResolver: PaymentAdapterResolver = {
  useForAccount: async () => {
    throw new Error("adapter should not be used for an empty page");
  },
};

describe("Agent Economy payment reconciliation worker", () => {
  test("uses one durable queue item per UTC hour across replicas", async () => {
    const queue = sharedQueue();
    const source: PaymentReceiptReconciliationSource = {
      list: async () => ({ candidates: [] }),
    };
    const checkpointStore: PaymentReconciliationCheckpointStore = {
      load: async () => undefined,
      save: async () => {},
    };
    const now = () => new Date("2026-09-29T15:42:15.000Z");

    const first = await sweepPaymentReconciliation({
      queue,
      owner: "replica-a",
      source,
      adapterResolver,
      auditStore,
      checkpointStore,
      now,
      renewEveryMs: 60_000,
    });
    const second = await sweepPaymentReconciliation({
      queue,
      owner: "replica-b",
      source,
      adapterResolver,
      auditStore,
      checkpointStore,
      now,
      renewEveryMs: 60_000,
    });

    expect(first.offered).toBe("queued");
    expect(first.claimed).toBe(true);
    expect(second.offered).toBe("already");
    expect(second.claimed).toBe(false);
    expect(reconciliationHourKey(now())).toBe("2026-09-29T15:00:00.000Z");
  });

  test("restores the durable cursor and checkpoints the next page", async () => {
    const queue = sharedQueue();
    const restored: PaymentReconciliationCursor = {
      verifiedAt: new Date("2026-09-28T20:00:00.000Z"),
      receiptId: "00000000-0000-0000-0000-000000000111",
    };
    const next: PaymentReconciliationCursor = {
      verifiedAt: new Date("2026-09-28T19:00:00.000Z"),
      receiptId: "00000000-0000-0000-0000-000000000099",
    };
    let seenCursor: PaymentReconciliationCursor | undefined;
    let savedCursor: PaymentReconciliationCursor | undefined;

    const source: PaymentReceiptReconciliationSource = {
      list: async (_batchSize, cursor) => {
        seenCursor = cursor;
        return { candidates: [], nextCursor: next };
      },
    };
    const checkpointStore: PaymentReconciliationCheckpointStore = {
      load: async () => restored,
      save: async (cursor) => {
        savedCursor = cursor;
      },
    };

    const report = await sweepPaymentReconciliation({
      queue,
      owner: "replica-a",
      source,
      adapterResolver,
      auditStore,
      checkpointStore,
      now: () => new Date("2026-09-29T16:05:00.000Z"),
      renewEveryMs: 60_000,
    });

    expect(seenCursor).toEqual(restored);
    expect(savedCursor).toEqual(next);
    expect(report.nextCursor).toEqual(next);
  });

  test("releases the queue item when checkpoint persistence fails", async () => {
    const queue = sharedQueue();
    const source: PaymentReceiptReconciliationSource = {
      list: async () => ({ candidates: [] }),
    };
    const checkpointStore: PaymentReconciliationCheckpointStore = {
      load: async () => undefined,
      save: async () => {
        throw new Error("checkpoint unavailable");
      },
    };

    await expect(
      sweepPaymentReconciliation({
        queue,
        owner: "replica-a",
        source,
        adapterResolver,
        auditStore,
        checkpointStore,
        now: () => new Date("2026-09-29T17:05:00.000Z"),
        renewEveryMs: 60_000,
      }),
    ).rejects.toThrow("checkpoint unavailable");

    const retry = await sweepPaymentReconciliation({
      queue,
      owner: "replica-b",
      source,
      adapterResolver,
      auditStore,
      checkpointStore: {
        load: async () => undefined,
        save: async () => {},
      },
      now: () => new Date("2026-09-29T17:05:00.000Z"),
      renewEveryMs: 60_000,
    });
    expect(retry.offered).toBe("already");
    expect(retry.claimed).toBe(true);
  });

  test("uses the reconciliation work kind", () => {
    expect(PAYMENT_RECONCILIATION_WORK_KIND).toBe(
      "economy_payment_reconciliation",
    );
  });
});
