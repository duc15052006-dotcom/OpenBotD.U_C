import type { AgentLedgerEntry, AssetClass } from "./model";

export type RevenueEventStatus = "pending" | "settled" | "failed" | "reversed";

export interface NormalizedRevenueEvent {
  adapterId: string;
  externalEventId: string;
  agentId: string;
  accountId: string;
  status: RevenueEventStatus;
  amountMinor: bigint;
  assetCode: string;
  assetClass: AssetClass;
  redeemable: boolean;
  source: string;
  occurredAt: Date;
  settledAt?: Date;
  evidence: Readonly<Record<string, unknown>>;
}

export interface RevenueEventPage {
  events: readonly NormalizedRevenueEvent[];
  nextCursor?: string;
}

export interface RevenueAdapter {
  readonly id: string;
  listRevenueEvents(cursor?: string): Promise<RevenueEventPage>;
}

export function validateRevenueEvent(event: NormalizedRevenueEvent): string[] {
  const errors: string[] = [];

  if (!event.adapterId.trim()) errors.push("adapterId is required");
  if (!event.externalEventId.trim()) errors.push("externalEventId is required");
  if (!event.agentId.trim()) errors.push("agentId is required");
  if (!event.accountId.trim()) errors.push("accountId is required");
  if (event.amountMinor <= 0n) errors.push("amountMinor must be positive");
  if (!event.assetCode.trim()) errors.push("assetCode is required");
  if (!event.source.trim()) errors.push("source is required");
  if (!Number.isFinite(event.occurredAt.getTime())) {
    errors.push("occurredAt must be a valid date");
  }
  if (event.status === "settled") {
    if (!event.settledAt || !Number.isFinite(event.settledAt.getTime())) {
      errors.push("settled revenue requires settledAt");
    }
  }

  return errors;
}

/**
 * Convert only settled, redeemable revenue into the accounting ledger.
 *
 * Pending money is never profit. Non-redeemable compute/internal credits may be valuable to the
 * Agent, but they are not cash-equivalent revenue and therefore do not enter distributable P&L.
 */
export function revenueLedgerEntry(
  event: NormalizedRevenueEvent,
): AgentLedgerEntry | null {
  const errors = validateRevenueEvent(event);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  if (!event.redeemable) return null;
  if (event.status !== "settled" && event.status !== "reversed") return null;

  const reversed = event.status === "reversed";
  const idempotencyKey = `revenue:${event.adapterId}:${event.externalEventId}:${event.status}`;

  return {
    id: idempotencyKey,
    agentId: event.agentId,
    accountId: event.accountId,
    idempotencyKey,
    type: reversed ? "revenue_reversal" : "revenue",
    direction: reversed ? "debit" : "credit",
    status: "settled",
    amountMinor: event.amountMinor,
    assetCode: event.assetCode,
    assetClass: event.assetClass,
    redeemable: true,
    occurredAt: reversed ? event.occurredAt : (event.settledAt ?? event.occurredAt),
  };
}

export function dedupeRevenueEvents(
  events: readonly NormalizedRevenueEvent[],
): NormalizedRevenueEvent[] {
  const seen = new Map<string, NormalizedRevenueEvent>();

  for (const event of events) {
    const errors = validateRevenueEvent(event);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }

    const key = `${event.adapterId}\u0000${event.externalEventId}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, event);
      continue;
    }

    if (
      existing.agentId !== event.agentId ||
      existing.accountId !== event.accountId ||
      existing.amountMinor !== event.amountMinor ||
      existing.assetCode !== event.assetCode
    ) {
      throw new Error(
        "revenue event identity was reused for conflicting financial terms",
      );
    }

    const rank: Record<RevenueEventStatus, number> = {
      pending: 0,
      failed: 1,
      settled: 2,
      reversed: 3,
    };
    if (rank[event.status] > rank[existing.status]) {
      seen.set(key, event);
    }
  }

  return [...seen.values()];
}
