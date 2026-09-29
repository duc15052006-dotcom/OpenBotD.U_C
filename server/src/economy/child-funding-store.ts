import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentChildFundingEvents,
  agentChildFundingReservations,
  agentFinancialAccounts,
  agentFundingRelationships,
  agentLedgerEntries,
  agentPaymentIntents,
  agentPaymentReceipts,
} from "../db/schema";
import type { AgentLedgerEntry, AssetClass } from "./model";

export class ChildFundingPersistenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildFundingPersistenceRefusedError";
  }
}

export interface PersistVerifiedChildFundingInput {
  reservationId: string;
  intentId: string;
}

export interface PersistedChildFundingEvent {
  id: string;
  relationshipId: string;
  intentId: string;
  receiptId: string;
  parentAgentId: string;
  childAgentId: string;
  amountMinor: bigint;
  assetCode: string;
  policyVersion: number;
  fundedAt: Date;
}

export interface PersistedChildFunding {
  event: PersistedChildFundingEvent;
  parentLedgerEntry: AgentLedgerEntry;
  childLedgerEntry: AgentLedgerEntry;
}

export interface ChildFundingStore {
  persistVerified(
    input: PersistVerifiedChildFundingInput,
  ): Promise<PersistedChildFunding>;
}

function positiveMoney(value: string, label: string): bigint {
  try {
    const amount = BigInt(value);
    if (amount <= 0n) throw new Error("non-positive");
    return amount;
  } catch {
    throw new ChildFundingPersistenceRefusedError(
      `stored child funding ${label} is invalid`,
    );
  }
}

function parseEvent(row: {
  id: string;
  relationshipId: string;
  intentId: string;
  receiptId: string;
  parentAgentId: string;
  childAgentId: string;
  amountMinor: string;
  assetCode: string;
  policyVersion: number;
  fundedAt: Date;
}): PersistedChildFundingEvent {
  const amountMinor = positiveMoney(row.amountMinor, "event amount");
  if (
    row.policyVersion <= 0 ||
    !row.id.trim() ||
    !row.relationshipId.trim() ||
    !row.intentId.trim() ||
    !row.receiptId.trim() ||
    !row.parentAgentId.trim() ||
    !row.childAgentId.trim() ||
    !row.assetCode.trim() ||
    Number.isNaN(row.fundedAt.getTime())
  ) {
    throw new ChildFundingPersistenceRefusedError(
      "stored child funding event is invalid",
    );
  }
  return { ...row, amountMinor };
}

function parseLedger(
  row: {
    id: string;
    agentId: string;
    accountId: string;
    idempotencyKey: string;
    type: string;
    direction: string;
    status: string;
    amountMinor: string;
    assetCode: string;
    assetClass: string;
    redeemable: boolean;
    occurredAt: Date;
  },
  expected: {
    type: "adjustment" | "investment";
    direction: "debit" | "credit";
  },
): AgentLedgerEntry {
  const amountMinor = positiveMoney(row.amountMinor, "ledger amount");
  if (
    row.type !== expected.type ||
    row.direction !== expected.direction ||
    row.status !== "settled" ||
    !row.id.trim() ||
    !row.agentId.trim() ||
    !row.accountId.trim() ||
    !row.idempotencyKey.trim() ||
    !row.assetCode.trim() ||
    Number.isNaN(row.occurredAt.getTime())
  ) {
    throw new ChildFundingPersistenceRefusedError(
      "stored child funding ledger entry is invalid",
    );
  }

  return {
    id: row.id,
    agentId: row.agentId,
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    type: expected.type,
    direction: expected.direction,
    status: "settled",
    amountMinor,
    assetCode: row.assetCode,
    assetClass: row.assetClass as AssetClass,
    redeemable: row.redeemable,
    occurredAt: row.occurredAt,
  };
}

export function createChildFundingStore(database: Database): ChildFundingStore {
  return {
    async persistVerified(input) {
      const reservationId = input.reservationId.trim();
      const intentId = input.intentId.trim();
      if (!reservationId || !intentId) {
        throw new ChildFundingPersistenceRefusedError(
          "child funding reservation and intent are required",
        );
      }

      return database.transaction(async (transaction) => {
        const [reservation] = await transaction
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
          })
          .from(agentChildFundingReservations)
          .where(
            and(
              eq(agentChildFundingReservations.id, reservationId),
              eq(agentChildFundingReservations.intentId, intentId),
            ),
          )
          .limit(1);

        if (!reservation) {
          throw new ChildFundingPersistenceRefusedError(
            "durable child funding reservation was not found",
          );
        }

        const reservedAmountMinor = positiveMoney(
          reservation.amountMinor,
          "reservation amount",
        );

        const [relationship] = await transaction
          .select({
            id: agentFundingRelationships.id,
            parentAgentId: agentFundingRelationships.parentAgentId,
            childAgentId: agentFundingRelationships.childAgentId,
            version: agentFundingRelationships.version,
            assetCode: agentFundingRelationships.assetCode,
          })
          .from(agentFundingRelationships)
          .where(eq(agentFundingRelationships.id, reservation.relationshipId))
          .limit(1)
          .for("update");

        if (
          !relationship ||
          relationship.parentAgentId !== reservation.parentAgentId ||
          relationship.childAgentId !== reservation.childAgentId ||
          relationship.assetCode !== reservation.assetCode ||
          relationship.version <= 0
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding reservation relationship is invalid",
          );
        }

        const [proof] = await transaction
          .select({
            intentId: agentPaymentIntents.id,
            agentId: agentPaymentIntents.agentId,
            accountId: agentPaymentIntents.accountId,
            idempotencyKey: agentPaymentIntents.idempotencyKey,
            kind: agentPaymentIntents.kind,
            amountMinor: agentPaymentIntents.amountMinor,
            destination: agentPaymentIntents.destination,
            decision: agentPaymentIntents.decision,
            policyVersion: agentPaymentIntents.policyVersion,
            receiptId: agentPaymentReceipts.id,
            receiptAgentId: agentPaymentReceipts.agentId,
            receiptAccountId: agentPaymentReceipts.accountId,
            receiptStatus: agentPaymentReceipts.providerStatus,
            receiptExternalReference: agentPaymentReceipts.externalReference,
            receiptAmountMinor: agentPaymentReceipts.amountMinor,
            receiptAssetCode: agentPaymentReceipts.assetCode,
            receiptDestination: agentPaymentReceipts.destination,
            receiptVerifiedAt: agentPaymentReceipts.verifiedAt,
          })
          .from(agentPaymentIntents)
          .innerJoin(
            agentPaymentReceipts,
            eq(agentPaymentReceipts.intentId, agentPaymentIntents.id),
          )
          .where(eq(agentPaymentIntents.id, intentId))
          .limit(1);

        if (
          !proof ||
          proof.kind !== "CHILD_FUNDING" ||
          proof.decision === "DENY" ||
          proof.agentId !== reservation.parentAgentId ||
          proof.accountId !== reservation.parentAccountId ||
          proof.policyVersion !== reservation.policyVersion ||
          proof.receiptAgentId !== reservation.parentAgentId ||
          proof.receiptAccountId !== reservation.parentAccountId ||
          proof.receiptStatus !== "verified" ||
          proof.receiptAssetCode !== reservation.assetCode ||
          proof.destination !== proof.receiptDestination ||
          !proof.receiptExternalReference.trim() ||
          Number.isNaN(proof.receiptVerifiedAt.getTime())
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "verified child funding proof does not match reservation",
          );
        }

        const intentAmountMinor = positiveMoney(
          proof.amountMinor,
          "intent amount",
        );
        const receiptAmountMinor = positiveMoney(
          proof.receiptAmountMinor,
          "receipt amount",
        );
        if (
          intentAmountMinor !== reservedAmountMinor ||
          receiptAmountMinor !== reservedAmountMinor
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "verified child funding amount does not match reservation",
          );
        }

        const [parentAccount] = await transaction
          .select({
            id: agentFinancialAccounts.id,
            agentId: agentFinancialAccounts.agentId,
            assetCode: agentFinancialAccounts.assetCode,
            assetClass: agentFinancialAccounts.assetClass,
            redeemable: agentFinancialAccounts.redeemable,
          })
          .from(agentFinancialAccounts)
          .where(eq(agentFinancialAccounts.id, reservation.parentAccountId))
          .limit(1);

        const [childAccount] = await transaction
          .select({
            id: agentFinancialAccounts.id,
            agentId: agentFinancialAccounts.agentId,
            assetCode: agentFinancialAccounts.assetCode,
            assetClass: agentFinancialAccounts.assetClass,
            redeemable: agentFinancialAccounts.redeemable,
            walletReference: agentFinancialAccounts.walletReference,
          })
          .from(agentFinancialAccounts)
          .where(eq(agentFinancialAccounts.id, reservation.childAccountId))
          .limit(1);

        if (
          !parentAccount ||
          parentAccount.agentId !== reservation.parentAgentId ||
          parentAccount.assetCode !== reservation.assetCode ||
          !childAccount ||
          childAccount.agentId !== reservation.childAgentId ||
          childAccount.assetCode !== reservation.assetCode ||
          !childAccount.walletReference?.trim() ||
          childAccount.walletReference !== proof.receiptDestination
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding financial accounts do not match reservation",
          );
        }

        await transaction
          .insert(agentChildFundingEvents)
          .values({
            relationshipId: relationship.id,
            intentId: proof.intentId,
            receiptId: proof.receiptId,
            parentAgentId: reservation.parentAgentId,
            childAgentId: reservation.childAgentId,
            amountMinor: reservedAmountMinor.toString(),
            assetCode: reservation.assetCode,
            policyVersion: reservation.policyVersion,
            fundedAt: proof.receiptVerifiedAt,
          })
          .onConflictDoNothing({ target: agentChildFundingEvents.intentId });

        const parentLedgerKey = `ledger:child-funding:parent:${proof.idempotencyKey}`;
        const childLedgerKey = `ledger:child-funding:child:${proof.idempotencyKey}`;

        await transaction
          .insert(agentLedgerEntries)
          .values({
            agentId: reservation.parentAgentId,
            accountId: reservation.parentAccountId,
            idempotencyKey: parentLedgerKey,
            type: "adjustment",
            direction: "debit",
            status: "settled",
            amountMinor: reservedAmountMinor.toString(),
            assetCode: reservation.assetCode,
            assetClass: parentAccount.assetClass,
            redeemable: parentAccount.redeemable,
            source: "child_funding",
            destination: proof.receiptDestination,
            purpose: "child_funding_parent_debit",
            approval: proof.decision,
            policyVersion: reservation.policyVersion,
            externalReference: proof.receiptExternalReference,
            occurredAt: proof.receiptVerifiedAt,
            metadata: {
              intentId: proof.intentId,
              relationshipId: relationship.id,
              childAgentId: reservation.childAgentId,
            },
          })
          .onConflictDoNothing({ target: agentLedgerEntries.idempotencyKey });

        await transaction
          .insert(agentLedgerEntries)
          .values({
            agentId: reservation.childAgentId,
            accountId: reservation.childAccountId,
            idempotencyKey: childLedgerKey,
            type: "investment",
            direction: "credit",
            status: "settled",
            amountMinor: reservedAmountMinor.toString(),
            assetCode: reservation.assetCode,
            assetClass: childAccount.assetClass,
            redeemable: childAccount.redeemable,
            source: "child_funding",
            destination: proof.receiptDestination,
            purpose: "child_funding_child_credit",
            approval: proof.decision,
            policyVersion: reservation.policyVersion,
            externalReference: proof.receiptExternalReference,
            occurredAt: proof.receiptVerifiedAt,
            metadata: {
              intentId: proof.intentId,
              relationshipId: relationship.id,
              parentAgentId: reservation.parentAgentId,
            },
          })
          .onConflictDoNothing({ target: agentLedgerEntries.idempotencyKey });

        const [storedEvent] = await transaction
          .select({
            id: agentChildFundingEvents.id,
            relationshipId: agentChildFundingEvents.relationshipId,
            intentId: agentChildFundingEvents.intentId,
            receiptId: agentChildFundingEvents.receiptId,
            parentAgentId: agentChildFundingEvents.parentAgentId,
            childAgentId: agentChildFundingEvents.childAgentId,
            amountMinor: agentChildFundingEvents.amountMinor,
            assetCode: agentChildFundingEvents.assetCode,
            policyVersion: agentChildFundingEvents.policyVersion,
            fundedAt: agentChildFundingEvents.fundedAt,
          })
          .from(agentChildFundingEvents)
          .where(eq(agentChildFundingEvents.intentId, intentId))
          .limit(1);

        const [storedParentLedger] = await transaction
          .select({
            id: agentLedgerEntries.id,
            agentId: agentLedgerEntries.agentId,
            accountId: agentLedgerEntries.accountId,
            idempotencyKey: agentLedgerEntries.idempotencyKey,
            type: agentLedgerEntries.type,
            direction: agentLedgerEntries.direction,
            status: agentLedgerEntries.status,
            amountMinor: agentLedgerEntries.amountMinor,
            assetCode: agentLedgerEntries.assetCode,
            assetClass: agentLedgerEntries.assetClass,
            redeemable: agentLedgerEntries.redeemable,
            occurredAt: agentLedgerEntries.occurredAt,
          })
          .from(agentLedgerEntries)
          .where(eq(agentLedgerEntries.idempotencyKey, parentLedgerKey))
          .limit(1);

        const [storedChildLedger] = await transaction
          .select({
            id: agentLedgerEntries.id,
            agentId: agentLedgerEntries.agentId,
            accountId: agentLedgerEntries.accountId,
            idempotencyKey: agentLedgerEntries.idempotencyKey,
            type: agentLedgerEntries.type,
            direction: agentLedgerEntries.direction,
            status: agentLedgerEntries.status,
            amountMinor: agentLedgerEntries.amountMinor,
            assetCode: agentLedgerEntries.assetCode,
            assetClass: agentLedgerEntries.assetClass,
            redeemable: agentLedgerEntries.redeemable,
            occurredAt: agentLedgerEntries.occurredAt,
          })
          .from(agentLedgerEntries)
          .where(eq(agentLedgerEntries.idempotencyKey, childLedgerKey))
          .limit(1);

        if (
          !storedEvent ||
          storedEvent.relationshipId !== relationship.id ||
          storedEvent.receiptId !== proof.receiptId ||
          storedEvent.parentAgentId !== reservation.parentAgentId ||
          storedEvent.childAgentId !== reservation.childAgentId ||
          BigInt(storedEvent.amountMinor) !== reservedAmountMinor ||
          storedEvent.assetCode !== reservation.assetCode ||
          storedEvent.policyVersion !== reservation.policyVersion ||
          storedEvent.fundedAt.getTime() !==
            proof.receiptVerifiedAt.getTime() ||
          !storedParentLedger ||
          !storedChildLedger
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding accounting conflicts with durable transfer proof",
          );
        }

        const parentLedgerEntry = parseLedger(storedParentLedger, {
          type: "adjustment",
          direction: "debit",
        });
        const childLedgerEntry = parseLedger(storedChildLedger, {
          type: "investment",
          direction: "credit",
        });

        if (
          parentLedgerEntry.agentId !== reservation.parentAgentId ||
          parentLedgerEntry.accountId !== reservation.parentAccountId ||
          parentLedgerEntry.amountMinor !== reservedAmountMinor ||
          parentLedgerEntry.assetCode !== reservation.assetCode ||
          childLedgerEntry.agentId !== reservation.childAgentId ||
          childLedgerEntry.accountId !== reservation.childAccountId ||
          childLedgerEntry.amountMinor !== reservedAmountMinor ||
          childLedgerEntry.assetCode !== reservation.assetCode
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding ledger identity conflicts with reservation",
          );
        }

        return {
          event: parseEvent(storedEvent),
          parentLedgerEntry,
          childLedgerEntry,
        };
      });
    },
  };
}
