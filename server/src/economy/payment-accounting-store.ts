import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentFinancialAccounts,
  agentLedgerEntries,
  agentPaymentIntents,
  agentPaymentReceipts,
} from "../db/schema";
import type { AgentLedgerEntry, AssetClass } from "./model";

export class PaymentAccountingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentAccountingRefusedError";
  }
}

export interface PaymentAccountingStore {
  persistOperatingPayment(intentId: string): Promise<AgentLedgerEntry>;
}

function parseLedger(row: {
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
}): AgentLedgerEntry {
  if (
    row.type !== "operating_cost" ||
    row.direction !== "debit" ||
    row.status !== "settled"
  ) {
    throw new PaymentAccountingRefusedError(
      "stored payment ledger entry has invalid accounting semantics",
    );
  }

  let amountMinor: bigint;
  try {
    amountMinor = BigInt(row.amountMinor);
  } catch {
    throw new PaymentAccountingRefusedError(
      "stored payment ledger amount is invalid",
    );
  }
  if (
    amountMinor <= 0n ||
    !row.id.trim() ||
    !row.agentId.trim() ||
    !row.accountId.trim() ||
    !row.idempotencyKey.trim() ||
    !row.assetCode.trim() ||
    Number.isNaN(row.occurredAt.getTime())
  ) {
    throw new PaymentAccountingRefusedError(
      "stored payment ledger entry is invalid",
    );
  }

  return {
    id: row.id,
    agentId: row.agentId,
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    type: "operating_cost",
    direction: "debit",
    status: "settled",
    amountMinor,
    assetCode: row.assetCode,
    assetClass: row.assetClass as AssetClass,
    redeemable: row.redeemable,
    occurredAt: row.occurredAt,
  };
}

export function createPaymentAccountingStore(
  database: Database,
): PaymentAccountingStore {
  return {
    async persistOperatingPayment(intentId) {
      const normalizedIntentId = intentId.trim();
      if (!normalizedIntentId) {
        throw new PaymentAccountingRefusedError(
          "payment intent id is required for accounting",
        );
      }

      return database.transaction(async (transaction) => {
        const [proof] = await transaction
          .select({
            intentId: agentPaymentIntents.id,
            agentId: agentPaymentIntents.agentId,
            accountId: agentPaymentIntents.accountId,
            idempotencyKey: agentPaymentIntents.idempotencyKey,
            kind: agentPaymentIntents.kind,
            amountMinor: agentPaymentIntents.amountMinor,
            destination: agentPaymentIntents.destination,
            category: agentPaymentIntents.category,
            decision: agentPaymentIntents.decision,
            policyVersion: agentPaymentIntents.policyVersion,
            receiptAgentId: agentPaymentReceipts.agentId,
            receiptAccountId: agentPaymentReceipts.accountId,
            receiptProviderStatus: agentPaymentReceipts.providerStatus,
            receiptExternalReference: agentPaymentReceipts.externalReference,
            receiptAmountMinor: agentPaymentReceipts.amountMinor,
            receiptAssetCode: agentPaymentReceipts.assetCode,
            receiptDestination: agentPaymentReceipts.destination,
            receiptVerifiedAt: agentPaymentReceipts.verifiedAt,
            accountAgentId: agentFinancialAccounts.agentId,
            accountAssetCode: agentFinancialAccounts.assetCode,
            accountAssetClass: agentFinancialAccounts.assetClass,
            accountRedeemable: agentFinancialAccounts.redeemable,
          })
          .from(agentPaymentIntents)
          .innerJoin(
            agentPaymentReceipts,
            eq(agentPaymentReceipts.intentId, agentPaymentIntents.id),
          )
          .innerJoin(
            agentFinancialAccounts,
            and(
              eq(agentFinancialAccounts.id, agentPaymentIntents.accountId),
              eq(agentFinancialAccounts.agentId, agentPaymentIntents.agentId),
            ),
          )
          .where(eq(agentPaymentIntents.id, normalizedIntentId))
          .limit(1);

        if (
          !proof ||
          (proof.kind !== "OPERATING_EXPENSE" &&
            proof.kind !== "X402_PAYMENT") ||
          proof.receiptProviderStatus !== "verified" ||
          proof.agentId !== proof.receiptAgentId ||
          proof.agentId !== proof.accountAgentId ||
          proof.accountId !== proof.receiptAccountId ||
          proof.destination !== proof.receiptDestination ||
          proof.receiptAssetCode !== proof.accountAssetCode ||
          !proof.receiptExternalReference.trim() ||
          !proof.category.trim() ||
          proof.policyVersion <= 0 ||
          proof.decision === "DENY" ||
          Number.isNaN(proof.receiptVerifiedAt.getTime())
        ) {
          throw new PaymentAccountingRefusedError(
            "verified payment proof does not match durable operating intent",
          );
        }

        let intentAmountMinor: bigint;
        let receiptAmountMinor: bigint;
        try {
          intentAmountMinor = BigInt(proof.amountMinor);
          receiptAmountMinor = BigInt(proof.receiptAmountMinor);
        } catch {
          throw new PaymentAccountingRefusedError(
            "verified payment amount is invalid",
          );
        }
        if (
          intentAmountMinor <= 0n ||
          intentAmountMinor !== receiptAmountMinor
        ) {
          throw new PaymentAccountingRefusedError(
            "verified payment amount does not match durable intent",
          );
        }

        const ledgerIdempotencyKey = `ledger:payment:${proof.idempotencyKey}`;

        await transaction
          .insert(agentLedgerEntries)
          .values({
            agentId: proof.agentId,
            accountId: proof.accountId,
            idempotencyKey: ledgerIdempotencyKey,
            type: "operating_cost",
            direction: "debit",
            status: "settled",
            amountMinor: intentAmountMinor.toString(),
            assetCode: proof.accountAssetCode,
            assetClass: proof.accountAssetClass,
            redeemable: proof.accountRedeemable,
            costCategory: proof.category,
            source: "payment_intent",
            destination: proof.destination,
            purpose:
              proof.kind === "X402_PAYMENT"
                ? "x402_payment"
                : "operating_expense",
            approval: proof.decision,
            policyVersion: proof.policyVersion,
            externalReference: proof.receiptExternalReference,
            occurredAt: proof.receiptVerifiedAt,
            metadata: {
              intentId: proof.intentId,
              kind: proof.kind,
            },
          })
          .onConflictDoNothing({
            target: agentLedgerEntries.idempotencyKey,
          });

        const [stored] = await transaction
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
            costCategory: agentLedgerEntries.costCategory,
            destination: agentLedgerEntries.destination,
            approval: agentLedgerEntries.approval,
            policyVersion: agentLedgerEntries.policyVersion,
            externalReference: agentLedgerEntries.externalReference,
            occurredAt: agentLedgerEntries.occurredAt,
          })
          .from(agentLedgerEntries)
          .where(eq(agentLedgerEntries.idempotencyKey, ledgerIdempotencyKey))
          .limit(1);

        if (
          !stored ||
          stored.agentId !== proof.agentId ||
          stored.accountId !== proof.accountId ||
          BigInt(stored.amountMinor) !== intentAmountMinor ||
          stored.assetCode !== proof.accountAssetCode ||
          stored.assetClass !== proof.accountAssetClass ||
          stored.redeemable !== proof.accountRedeemable ||
          stored.costCategory !== proof.category ||
          stored.destination !== proof.destination ||
          stored.approval !== proof.decision ||
          stored.policyVersion !== proof.policyVersion ||
          stored.externalReference !== proof.receiptExternalReference ||
          stored.occurredAt.getTime() !== proof.receiptVerifiedAt.getTime()
        ) {
          throw new PaymentAccountingRefusedError(
            "payment ledger entry conflicts with durable transfer proof",
          );
        }

        return parseLedger(stored);
      });
    },
  };
}
