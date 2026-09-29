import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentChildFundingEvents,
  agentChildFundingReservations,
  agentFinancialAccounts,
  agentFundingRelationships,
  agentPaymentReceipts,
  agentProfiles,
} from "../db/schema";
import type { DurablePaymentIntent } from "./payment-intent-store";

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1_000;

export class ChildFundingReservationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildFundingReservationRefusedError";
  }
}

export interface ChildFundingReservation {
  id: string;
  relationshipId: string;
  intentId: string;
  parentAgentId: string;
  parentAccountId: string;
  childAgentId: string;
  childAccountId: string;
  amountMinor: bigint;
  assetCode: string;
  policyVersion: number;
  reservedUntil: Date;
  createdAt: Date;
}

export interface ChildFundingReservationStore {
  reserve(intent: DurablePaymentIntent): Promise<ChildFundingReservation>;
}

function parseMoney(value: string, label: string): bigint {
  try {
    const amount = BigInt(value);
    if (amount < 0n) throw new Error("negative");
    return amount;
  } catch {
    throw new ChildFundingReservationRefusedError(
      `stored child funding ${label} is invalid`,
    );
  }
}

function parseReservation(row: {
  id: string;
  relationshipId: string;
  intentId: string;
  parentAgentId: string;
  parentAccountId: string;
  childAgentId: string;
  childAccountId: string;
  amountMinor: string;
  assetCode: string;
  policyVersion: number;
  reservedUntil: Date;
  createdAt: Date;
}): ChildFundingReservation {
  const amountMinor = parseMoney(row.amountMinor, "reservation amount");
  if (
    amountMinor <= 0n ||
    row.policyVersion <= 0 ||
    !row.id.trim() ||
    !row.relationshipId.trim() ||
    !row.intentId.trim() ||
    !row.parentAgentId.trim() ||
    !row.parentAccountId.trim() ||
    !row.childAgentId.trim() ||
    !row.childAccountId.trim() ||
    !row.assetCode.trim() ||
    Number.isNaN(row.reservedUntil.getTime()) ||
    Number.isNaN(row.createdAt.getTime())
  ) {
    throw new ChildFundingReservationRefusedError(
      "stored child funding reservation is invalid",
    );
  }
  return { ...row, amountMinor };
}

function requireIntent(intent: DurablePaymentIntent): void {
  if (
    intent.kind !== "CHILD_FUNDING" ||
    intent.decision === "DENY" ||
    intent.amountMinor <= 0n ||
    !intent.id.trim() ||
    !intent.agentId.trim() ||
    !intent.accountId.trim() ||
    !intent.assetCode.trim() ||
    !intent.destination.trim() ||
    intent.policyVersion <= 0
  ) {
    throw new ChildFundingReservationRefusedError(
      "durable child funding intent is invalid",
    );
  }
}

export function calculateCommittedChildFundingMinor(input: {
  events: readonly { intentId: string; amountMinor: string }[];
  reservations: readonly {
    intentId: string;
    amountMinor: string;
    reservedUntil: Date;
  }[];
  verifiedReceiptIntentIds: ReadonlySet<string>;
  now: Date;
}): bigint {
  if (Number.isNaN(input.now.getTime())) {
    throw new ChildFundingReservationRefusedError(
      "child funding reservation clock is invalid",
    );
  }

  let committedMinor = 0n;
  const eventIntents = new Set<string>();

  for (const row of input.events) {
    const amount = parseMoney(row.amountMinor, "funding event amount");
    if (amount <= 0n) {
      throw new ChildFundingReservationRefusedError(
        "stored child funding event amount is invalid",
      );
    }
    committedMinor += amount;
    eventIntents.add(row.intentId);
  }

  for (const row of input.reservations) {
    if (eventIntents.has(row.intentId)) continue;
    if (
      row.reservedUntil <= input.now &&
      !input.verifiedReceiptIntentIds.has(row.intentId)
    ) {
      continue;
    }
    const amount = parseMoney(row.amountMinor, "reservation amount");
    if (amount <= 0n) {
      throw new ChildFundingReservationRefusedError(
        "stored child funding reservation amount is invalid",
      );
    }
    committedMinor += amount;
  }

  return committedMinor;
}

export function createChildFundingReservationStore(
  database: Database,
  options: {
    now?: () => Date;
    ttlMs?: number;
  } = {},
): ChildFundingReservationStore {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ChildFundingReservationRefusedError(
      "child funding reservation TTL is invalid",
    );
  }

  return {
    async reserve(intent) {
      requireIntent(intent);
      const current = now();
      if (Number.isNaN(current.getTime())) {
        throw new ChildFundingReservationRefusedError(
          "child funding reservation clock is invalid",
        );
      }

      return database.transaction(async (transaction) => {
        const childAccounts = await transaction
          .select({
            id: agentFinancialAccounts.id,
            agentId: agentFinancialAccounts.agentId,
            assetCode: agentFinancialAccounts.assetCode,
            profileAgentId: agentProfiles.agentId,
          })
          .from(agentFinancialAccounts)
          .leftJoin(
            agentProfiles,
            and(
              eq(agentProfiles.agentId, agentFinancialAccounts.agentId),
              isNull(agentProfiles.deletedAt),
            ),
          )
          .where(
            and(
              eq(agentFinancialAccounts.assetCode, intent.assetCode),
              eq(agentFinancialAccounts.walletReference, intent.destination),
            ),
          )
          .limit(2);

        if (
          childAccounts.length !== 1 ||
          !childAccounts[0]?.profileAgentId ||
          childAccounts[0].agentId === intent.agentId
        ) {
          throw new ChildFundingReservationRefusedError(
            "child funding destination does not resolve to one active child account",
          );
        }
        const childAccount = childAccounts[0];

        const [relationship] = await transaction
          .select({
            id: agentFundingRelationships.id,
            parentAgentId: agentFundingRelationships.parentAgentId,
            childAgentId: agentFundingRelationships.childAgentId,
            version: agentFundingRelationships.version,
            budgetMinor: agentFundingRelationships.budgetMinor,
            assetCode: agentFundingRelationships.assetCode,
            active: agentFundingRelationships.active,
            frozen: agentFundingRelationships.frozen,
          })
          .from(agentFundingRelationships)
          .where(
            and(
              eq(agentFundingRelationships.parentAgentId, intent.agentId),
              eq(agentFundingRelationships.childAgentId, childAccount.agentId),
            ),
          )
          .orderBy(desc(agentFundingRelationships.version))
          .limit(1)
          .for("update");

        if (
          !relationship?.active ||
          relationship.frozen ||
          relationship.parentAgentId !== intent.agentId ||
          relationship.childAgentId !== childAccount.agentId ||
          relationship.assetCode !== intent.assetCode ||
          relationship.version <= 0
        ) {
          throw new ChildFundingReservationRefusedError(
            "latest child funding relationship is unavailable",
          );
        }

        const budgetMinor = parseMoney(
          relationship.budgetMinor,
          "relationship budget",
        );

        const [existingRow] = await transaction
          .select({
            id: agentChildFundingReservations.id,
            relationshipId: agentChildFundingReservations.relationshipId,
            intentId: agentChildFundingReservations.intentId,
            parentAgentId: agentChildFundingReservations.parentAgentId,
            parentAccountId: agentChildFundingReservations.parentAccountId,
            childAgentId: agentChildFundingReservations.childAgentId,
            childAccountId: agentChildFundingReservations.childAccountId,
            amountMinor: agentChildFundingReservations.amountMinor,
            assetCode: agentChildFundingReservations.assetCode,
            policyVersion: agentChildFundingReservations.policyVersion,
            reservedUntil: agentChildFundingReservations.reservedUntil,
            createdAt: agentChildFundingReservations.createdAt,
          })
          .from(agentChildFundingReservations)
          .where(eq(agentChildFundingReservations.intentId, intent.id))
          .limit(1);

        if (existingRow) {
          const existing = parseReservation(existingRow);
          if (
            existing.relationshipId !== relationship.id ||
            existing.parentAgentId !== intent.agentId ||
            existing.parentAccountId !== intent.accountId ||
            existing.childAgentId !== childAccount.agentId ||
            existing.childAccountId !== childAccount.id ||
            existing.amountMinor !== intent.amountMinor ||
            existing.assetCode !== intent.assetCode ||
            existing.policyVersion !== intent.policyVersion
          ) {
            throw new ChildFundingReservationRefusedError(
              "child funding reservation conflicts with durable intent",
            );
          }

          if (existing.reservedUntil > current) return existing;

          const [committedReceipt] = await transaction
            .select({ id: agentPaymentReceipts.id })
            .from(agentPaymentReceipts)
            .where(
              and(
                eq(agentPaymentReceipts.intentId, intent.id),
                eq(agentPaymentReceipts.providerStatus, "verified"),
              ),
            )
            .limit(1);

          const [fundedEvent] = await transaction
            .select({ id: agentChildFundingEvents.id })
            .from(agentChildFundingEvents)
            .where(eq(agentChildFundingEvents.intentId, intent.id))
            .limit(1);

          if (committedReceipt || fundedEvent) return existing;

          throw new ChildFundingReservationRefusedError(
            "child funding reservation expired before transfer; create a new intent",
          );
        }

        const eventRows = await transaction
          .select({
            intentId: agentChildFundingEvents.intentId,
            amountMinor: agentChildFundingEvents.amountMinor,
          })
          .from(agentChildFundingEvents)
          .where(eq(agentChildFundingEvents.relationshipId, relationship.id));

        const eventIntents = new Set(eventRows.map((row) => row.intentId));

        const reservationRows = await transaction
          .select({
            intentId: agentChildFundingReservations.intentId,
            amountMinor: agentChildFundingReservations.amountMinor,
            reservedUntil: agentChildFundingReservations.reservedUntil,
          })
          .from(agentChildFundingReservations)
          .where(
            eq(agentChildFundingReservations.relationshipId, relationship.id),
          );

        const orphanIntents = reservationRows
          .filter((row) => !eventIntents.has(row.intentId))
          .map((row) => row.intentId);

        const receiptIntents = new Set<string>();
        if (orphanIntents.length > 0) {
          const receiptRows = await transaction
            .select({ intentId: agentPaymentReceipts.intentId })
            .from(agentPaymentReceipts)
            .where(
              and(
                inArray(agentPaymentReceipts.intentId, orphanIntents),
                eq(agentPaymentReceipts.providerStatus, "verified"),
              ),
            );
          for (const row of receiptRows) receiptIntents.add(row.intentId);
        }

        const committedMinor = calculateCommittedChildFundingMinor({
          events: eventRows,
          reservations: reservationRows,
          verifiedReceiptIntentIds: receiptIntents,
          now: current,
        });

        if (committedMinor + intent.amountMinor > budgetMinor) {
          throw new ChildFundingReservationRefusedError(
            "child funding exceeds latest relationship budget",
          );
        }

        const reservedUntil = new Date(current.getTime() + ttlMs);
        await transaction.insert(agentChildFundingReservations).values({
          relationshipId: relationship.id,
          intentId: intent.id,
          parentAgentId: intent.agentId,
          parentAccountId: intent.accountId,
          childAgentId: childAccount.agentId,
          childAccountId: childAccount.id,
          amountMinor: intent.amountMinor.toString(),
          assetCode: intent.assetCode,
          policyVersion: intent.policyVersion,
          reservedUntil,
        });

        const [storedRow] = await transaction
          .select({
            id: agentChildFundingReservations.id,
            relationshipId: agentChildFundingReservations.relationshipId,
            intentId: agentChildFundingReservations.intentId,
            parentAgentId: agentChildFundingReservations.parentAgentId,
            parentAccountId: agentChildFundingReservations.parentAccountId,
            childAgentId: agentChildFundingReservations.childAgentId,
            childAccountId: agentChildFundingReservations.childAccountId,
            amountMinor: agentChildFundingReservations.amountMinor,
            assetCode: agentChildFundingReservations.assetCode,
            policyVersion: agentChildFundingReservations.policyVersion,
            reservedUntil: agentChildFundingReservations.reservedUntil,
            createdAt: agentChildFundingReservations.createdAt,
          })
          .from(agentChildFundingReservations)
          .where(eq(agentChildFundingReservations.intentId, intent.id))
          .limit(1);

        if (!storedRow) {
          throw new ChildFundingReservationRefusedError(
            "child funding reservation was not persisted",
          );
        }
        return parseReservation(storedRow);
      });
    },
  };
}
