import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentChildFundingEvents,
  agentFinancialAccounts,
  agentFundingRelationships,
  agentPaymentIntents,
  agentPaymentReceipts,
} from "../db/schema";

export class ChildFundingPersistenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildFundingPersistenceRefusedError";
  }
}

export interface PersistVerifiedChildFundingInput {
  relationshipId: string;
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

export interface ChildFundingStore {
  persistVerified(
    input: PersistVerifiedChildFundingInput,
  ): Promise<PersistedChildFundingEvent>;
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
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(row.amountMinor);
  } catch {
    throw new ChildFundingPersistenceRefusedError(
      "stored child funding event amount is invalid",
    );
  }
  if (
    amountMinor <= 0n ||
    row.policyVersion <= 0 ||
    Number.isNaN(row.fundedAt.getTime())
  ) {
    throw new ChildFundingPersistenceRefusedError(
      "stored child funding event is invalid",
    );
  }
  return { ...row, amountMinor };
}

export function createChildFundingStore(database: Database): ChildFundingStore {
  return {
    async persistVerified(input) {
      const relationshipId = input.relationshipId.trim();
      const intentId = input.intentId.trim();
      if (!relationshipId || !intentId) {
        throw new ChildFundingPersistenceRefusedError(
          "child funding relationship and intent are required",
        );
      }

      return database.transaction(async (transaction) => {
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
          .where(eq(agentFundingRelationships.id, relationshipId))
          .limit(1)
          .for("update");

        if (!relationship || !relationship.active || relationship.frozen) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding relationship is unavailable",
          );
        }

        let budgetMinor: bigint;
        try {
          budgetMinor = BigInt(relationship.budgetMinor);
        } catch {
          throw new ChildFundingPersistenceRefusedError(
            "child funding relationship budget is invalid",
          );
        }
        if (
          relationship.parentAgentId === relationship.childAgentId ||
          relationship.version <= 0 ||
          budgetMinor < 0n ||
          !relationship.assetCode.trim()
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding relationship is invalid",
          );
        }

        const [existing] = await transaction
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

        if (existing) {
          const parsed = parseEvent(existing);
          if (parsed.relationshipId !== relationship.id) {
            throw new ChildFundingPersistenceRefusedError(
              "child funding intent belongs to another relationship",
            );
          }
          return parsed;
        }

        const [proof] = await transaction
          .select({
            intentId: agentPaymentIntents.id,
            intentAgentId: agentPaymentIntents.agentId,
            intentKind: agentPaymentIntents.kind,
            intentAmountMinor: agentPaymentIntents.amountMinor,
            intentDestination: agentPaymentIntents.destination,
            intentPolicyVersion: agentPaymentIntents.policyVersion,
            receiptId: agentPaymentReceipts.id,
            receiptAgentId: agentPaymentReceipts.agentId,
            receiptStatus: agentPaymentReceipts.providerStatus,
            receiptAmountMinor: agentPaymentReceipts.amountMinor,
            receiptAssetCode: agentPaymentReceipts.assetCode,
            receiptDestination: agentPaymentReceipts.destination,
            receiptVerifiedAt: agentPaymentReceipts.verifiedAt,
            childAccountId: agentFinancialAccounts.id,
            childAccountAgentId: agentFinancialAccounts.agentId,
            childAccountAssetCode: agentFinancialAccounts.assetCode,
            childWalletReference: agentFinancialAccounts.walletReference,
          })
          .from(agentPaymentIntents)
          .innerJoin(
            agentPaymentReceipts,
            eq(agentPaymentReceipts.intentId, agentPaymentIntents.id),
          )
          .innerJoin(
            agentFinancialAccounts,
            and(
              eq(
                agentFinancialAccounts.agentId,
                relationship.childAgentId,
              ),
              eq(
                agentFinancialAccounts.assetCode,
                agentPaymentReceipts.assetCode,
              ),
              eq(
                agentFinancialAccounts.walletReference,
                agentPaymentReceipts.destination,
              ),
            ),
          )
          .where(eq(agentPaymentIntents.id, intentId))
          .limit(1);

        if (
          !proof ||
          proof.intentKind !== "CHILD_FUNDING" ||
          proof.intentAgentId !== relationship.parentAgentId ||
          proof.receiptAgentId !== relationship.parentAgentId ||
          proof.receiptStatus !== "verified" ||
          proof.childAccountAgentId !== relationship.childAgentId ||
          !proof.childWalletReference?.trim() ||
          proof.childWalletReference !== proof.receiptDestination ||
          proof.intentDestination !== proof.receiptDestination ||
          proof.receiptAssetCode !== relationship.assetCode ||
          proof.childAccountAssetCode !== relationship.assetCode ||
          proof.intentPolicyVersion <= 0 ||
          Number.isNaN(proof.receiptVerifiedAt.getTime())
        ) {
          throw new ChildFundingPersistenceRefusedError(
            "verified child funding proof does not match relationship",
          );
        }

        let amountMinor: bigint;
        let receiptAmountMinor: bigint;
        try {
          amountMinor = BigInt(proof.intentAmountMinor);
          receiptAmountMinor = BigInt(proof.receiptAmountMinor);
        } catch {
          throw new ChildFundingPersistenceRefusedError(
            "verified child funding amount is invalid",
          );
        }
        if (amountMinor <= 0n || amountMinor !== receiptAmountMinor) {
          throw new ChildFundingPersistenceRefusedError(
            "verified child funding amount does not match intent",
          );
        }

        const prior = await transaction
          .select({ amountMinor: agentChildFundingEvents.amountMinor })
          .from(agentChildFundingEvents)
          .where(
            eq(agentChildFundingEvents.relationshipId, relationship.id),
          );

        let fundedMinor = 0n;
        for (const row of prior) {
          try {
            fundedMinor += BigInt(row.amountMinor);
          } catch {
            throw new ChildFundingPersistenceRefusedError(
              "stored child funding history is invalid",
            );
          }
        }
        if (fundedMinor + amountMinor > budgetMinor) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding exceeds relationship budget",
          );
        }

        await transaction.insert(agentChildFundingEvents).values({
          relationshipId: relationship.id,
          intentId: proof.intentId,
          receiptId: proof.receiptId,
          parentAgentId: relationship.parentAgentId,
          childAgentId: relationship.childAgentId,
          amountMinor: amountMinor.toString(),
          assetCode: relationship.assetCode,
          policyVersion: proof.intentPolicyVersion,
          fundedAt: proof.receiptVerifiedAt,
        });

        const [stored] = await transaction
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

        if (!stored) {
          throw new ChildFundingPersistenceRefusedError(
            "child funding event was not persisted",
          );
        }
        return parseEvent(stored);
      });
    },
  };
}
