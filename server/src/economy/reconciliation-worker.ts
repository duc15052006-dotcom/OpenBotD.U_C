import { desc, eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import type { WorkQueue } from "../work/queue";
import type { PaymentAdapterResolver } from "./payment-adapter-resolver";
import {
  reconcileVerifiedPaymentReceipts,
  type PaymentReceiptReconciliationSource,
  type PaymentReconciliationCursor,
  type PaymentReconciliationReport,
} from "./reconciliation";

export const PAYMENT_RECONCILIATION_WORK_KIND =
  "economy_payment_reconciliation";

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;

export interface PaymentReconciliationCheckpointStore {
  load(): Promise<PaymentReconciliationCursor | undefined>;
  save(cursor: PaymentReconciliationCursor | undefined): Promise<void>;
}

export interface PaymentReconciliationWorkerOptions {
  queue: WorkQueue;
  owner: string;
  source: PaymentReceiptReconciliationSource;
  adapterResolver: PaymentAdapterResolver;
  auditStore: AuditStore;
  checkpointStore: PaymentReconciliationCheckpointStore;
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  renewEveryMs?: number;
}

export function reconciliationHourKey(now: Date): string {
  const stamp = new Date(now);
  if (Number.isNaN(stamp.getTime())) {
    throw new Error("payment reconciliation clock is invalid");
  }
  stamp.setUTCMinutes(0, 0, 0);
  return stamp.toISOString();
}

export function createPaymentReconciliationCheckpointStore(
  database: Database,
  auditStore: AuditStore,
): PaymentReconciliationCheckpointStore {
  return {
    async load() {
      const [row] = await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          eq(
            auditEvents.eventType,
            "economy.payment_reconciliation_checkpoint",
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(1);

      if (!row) return undefined;
      const payload = row.payload as Record<string, unknown>;
      if (payload.complete === true) return undefined;
      if (
        typeof payload.verifiedAt !== "string" ||
        typeof payload.receiptId !== "string" ||
        !payload.receiptId.trim()
      ) {
        throw new Error("payment reconciliation checkpoint is invalid");
      }
      const verifiedAt = new Date(payload.verifiedAt);
      if (Number.isNaN(verifiedAt.getTime())) {
        throw new Error("payment reconciliation checkpoint timestamp is invalid");
      }
      return { verifiedAt, receiptId: payload.receiptId };
    },

    async save(cursor) {
      await recordAuditEvent(auditStore, {
        eventType: "economy.payment_reconciliation_checkpoint",
        targetType: "payment_reconciliation",
        initiator: DEPLOYMENT_INITIATOR,
        payload: cursor
          ? {
              complete: false,
              verifiedAt: cursor.verifiedAt.toISOString(),
              receiptId: cursor.receiptId,
            }
          : { complete: true },
      });
    },
  };
}

export async function sweepPaymentReconciliation(
  options: PaymentReconciliationWorkerOptions,
): Promise<
  PaymentReconciliationReport & {
    offered: "queued" | "already" | "refused";
    claimed: boolean;
  }
> {
  const now = options.now?.() ?? new Date();
  const key = reconciliationHourKey(now);
  const offered = await options.queue.offer({
    kind: PAYMENT_RECONCILIATION_WORK_KIND,
    key,
  });

  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const [item] = await options.queue.claim({
    kind: PAYMENT_RECONCILIATION_WORK_KIND,
    owner: options.owner,
    leaseMs,
    limit: 1,
    maxAttempts: 3,
  });

  if (!item) {
    return {
      offered,
      claimed: false,
      checked: 0,
      verified: 0,
      failed: 0,
      auditWriteFailures: 0,
    };
  }

  const renewEveryMs =
    options.renewEveryMs ??
    Math.min(30_000, Math.max(1_000, Math.floor(leaseMs / 3)));
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    const cursor = await options.checkpointStore.load();

    const stillOurs = await options.queue.renew({
      kind: PAYMENT_RECONCILIATION_WORK_KIND,
      key: item.key,
      owner: options.owner,
      leaseMs,
    });
    if (!stillOurs) {
      return {
        offered,
        claimed: false,
        checked: 0,
        verified: 0,
        failed: 0,
        auditWriteFailures: 0,
      };
    }

    heartbeat = setInterval(() => {
      void options.queue
        .renew({
          kind: PAYMENT_RECONCILIATION_WORK_KIND,
          key: item.key,
          owner: options.owner,
          leaseMs,
        })
        .catch(() => {});
    }, renewEveryMs);
    heartbeat.unref?.();

    const report = await reconcileVerifiedPaymentReceipts({
      source: options.source,
      adapterResolver: options.adapterResolver,
      auditStore: options.auditStore,
      batchSize: options.batchSize ?? 100,
      ...(cursor ? { cursor } : {}),
    });

    await options.checkpointStore.save(report.nextCursor);

    const finished = await options.queue.finish({
      kind: PAYMENT_RECONCILIATION_WORK_KIND,
      key: item.key,
      owner: options.owner,
    });
    if (!finished) {
      throw new Error("payment reconciliation lease was lost before finish");
    }

    return { ...report, offered, claimed: true };
  } catch (error) {
    await options.queue.release({
      kind: PAYMENT_RECONCILIATION_WORK_KIND,
      key: item.key,
      owner: options.owner,
      delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      reason:
        error instanceof Error
          ? error.message
          : "payment reconciliation sweep failed",
    });
    throw error;
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}
