import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentLedgerEntries,
  agentPaymentReceipts,
  agentPayouts,
} from "../db/schema";
import type { AgentLedgerEntry, AssetClass } from "./model";

export class OwnerPayoutAccountingConflictError extends Error {
  constructor(intentId: string) {
    super(
      `Owner payout accounting for intent ${intentId} conflicts with durable history.`,
    );
    this.name = "OwnerPayoutAccountingConflictError";
  }
}

export class OwnerPayoutReceiptNotFoundError extends Error {
  constructor(intentId: string) {
    super(`Verified receipt for payout intent ${intentId} was not found.`);
    this.name = "OwnerPayoutReceiptNotFoundError";
  }
}

export interface PersistOwnerPayoutAccountingInput {
  intentId: string;
  agentId: string;
  accountId: string;
  payoutIdempotencyKey: string;
  assetCode: string;
  assetClass: AssetClass;
  amountMinor: bigint;
  destination: string;
  distributableProfitBeforeMinor: bigint;
  reserveBeforeMinor: bigint;
  policyVersion: number;
  requestedBy: string;
  approval: string;
  externalReference: string;
  paidAt: Date;
}

export interface PersistedOwnerPayoutAccounting {
  payoutId: string;
  ledgerEntry: AgentLedgerEntry;
}

export interface OwnerPayoutAccountingStore {
  persist(
    input: PersistOwnerPayoutAccountingInput,
  ): Promise<PersistedOwnerPayoutAccounting>;
}

function requireValidInput(input: PersistOwnerPayoutAccountingInput): void {
  if (
    !input.intentId.trim() ||
    !input.agentId.trim() ||
    !input.accountId.trim() ||
    !input.payoutIdempotencyKey.trim() ||
    !input.assetCode.trim() ||
    input.amountMinor <= 0n ||
    !input.destination.trim() ||
    input.distributableProfitBeforeMinor < input.amountMinor ||
    input.reserveBeforeMinor < 0n ||
    !Number.isInteger(input.policyVersion) ||
    input.policyVersion <= 0 ||
    !input.requestedBy.trim() ||
    !input.approval.trim() ||
    !input.externalReference.trim() ||
    Number.isNaN(input.paidAt.getTime())
  ) {
    throw new OwnerPayoutAccountingConflictError(input.intentId);
  }
}

function ledgerFromRow(row: {
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
}): AgentLedgerEntry | null {
  if (
    row.type !== "owner_payout" ||
    row.direction !== "debit" ||
    row.status !== "settled"
  ) {
    return null;
  }
  return {
    id: row.id,
    agentId: row.agentId,
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    type: "owner_payout",
    direction: "debit",
    status: "settled",
    amountMinor: BigInt(row.amountMinor),
    assetCode: row.assetCode,
    assetClass: row.assetClass as AssetClass,
    redeemable: row.redeemable,
    occurredAt: row.occurredAt,
  };
}

export function createOwnerPayoutAccountingStore(
  database: Database,
): OwnerPayoutAccountingStore {
  return {
    async persist(input) {
      requireValidInput(input);
      const ledgerIdempotencyKey = `ledger:${input.payoutIdempotencyKey}`;

      return database.transaction(async (transaction) => {
        const [receipt] = await transaction
          .select({
            id: agentPaymentReceipts.id,
            intentId: agentPaymentReceipts.intentId,
            agentId: agentPaymentReceipts.agentId,
            accountId: agentPaymentReceipts.accountId,
            providerStatus: agentPaymentReceipts.providerStatus,
            externalReference: agentPaymentReceipts.externalReference,
            assetCode: agentPaymentReceipts.assetCode,
            amountMinor: agentPaymentReceipts.amountMinor,
            destination: agentPaymentReceipts.destination,
          })
          .from(agentPaymentReceipts)
          .where(eq(agentPaymentReceipts.intentId, input.intentId))
          .limit(1);

        if (!receipt) {
          throw new OwnerPayoutReceiptNotFoundError(input.intentId);
        }
        if (
          receipt.intentId !== input.intentId ||
          receipt.agentId !== input.agentId ||
          receipt.accountId !== input.accountId ||
          receipt.providerStatus !== "verified" ||
          receipt.externalReference !== input.externalReference ||
          receipt.assetCode !== input.assetCode ||
          BigInt(receipt.amountMinor) !== input.amountMinor ||
          receipt.destination !== input.destination
        ) {
          throw new OwnerPayoutAccountingConflictError(input.intentId);
        }

        await transaction
          .insert(agentPayouts)
          .values({
            intentId: input.intentId,
            receiptId: receipt.id,
            agentId: input.agentId,
            accountId: input.accountId,
            mode: "manual",
            assetCode: input.assetCode,
            amountMinor: input.amountMinor.toString(),
            destination: input.destination,
            distributableProfitBeforeMinor:
              input.distributableProfitBeforeMinor.toString(),
            reserveBeforeMinor: input.reserveBeforeMinor.toString(),
            policyVersion: input.policyVersion,
            requestedBy: input.requestedBy,
            paidAt: input.paidAt,
          })
          .onConflictDoNothing({ target: agentPayouts.intentId });

        await transaction
          .insert(agentLedgerEntries)
          .values({
            agentId: input.agentId,
            accountId: input.accountId,
            idempotencyKey: ledgerIdempotencyKey,
            type: "owner_payout",
            direction: "debit",
            status: "settled",
            amountMinor: input.amountMinor.toString(),
            assetCode: input.assetCode,
            assetClass: input.assetClass,
            redeemable: true,
            source: "owner_payout",
            destination: input.destination,
            purpose: "owner_payout",
            approval: input.approval,
            policyVersion: input.policyVersion,
            externalReference: input.externalReference,
            occurredAt: input.paidAt,
            metadata: { mode: "manual", intentId: input.intentId },
          })
          .onConflictDoNothing({
            target: agentLedgerEntries.idempotencyKey,
          });

        const [storedPayout] = await transaction
          .select({
            id: agentPayouts.id,
            intentId: agentPayouts.intentId,
            receiptId: agentPayouts.receiptId,
            agentId: agentPayouts.agentId,
            accountId: agentPayouts.accountId,
            mode: agentPayouts.mode,
            assetCode: agentPayouts.assetCode,
            amountMinor: agentPayouts.amountMinor,
            destination: agentPayouts.destination,
            distributableProfitBeforeMinor:
              agentPayouts.distributableProfitBeforeMinor,
            reserveBeforeMinor: agentPayouts.reserveBeforeMinor,
            policyVersion: agentPayouts.policyVersion,
            requestedBy: agentPayouts.requestedBy,
            paidAt: agentPayouts.paidAt,
          })
          .from(agentPayouts)
          .where(eq(agentPayouts.intentId, input.intentId))
          .limit(1);

        const [storedLedger] = await transaction
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
            destination: agentLedgerEntries.destination,
            policyVersion: agentLedgerEntries.policyVersion,
            externalReference: agentLedgerEntries.externalReference,
            occurredAt: agentLedgerEntries.occurredAt,
          })
          .from(agentLedgerEntries)
          .where(eq(agentLedgerEntries.idempotencyKey, ledgerIdempotencyKey))
          .limit(1);

        const ledgerEntry = storedLedger ? ledgerFromRow(storedLedger) : null;
        if (
          !storedPayout ||
          storedPayout.receiptId !== receipt.id ||
          storedPayout.agentId !== input.agentId ||
          storedPayout.accountId !== input.accountId ||
          storedPayout.mode !== "manual" ||
          storedPayout.assetCode !== input.assetCode ||
          BigInt(storedPayout.amountMinor) !== input.amountMinor ||
          storedPayout.destination !== input.destination ||
          BigInt(storedPayout.distributableProfitBeforeMinor) !==
            input.distributableProfitBeforeMinor ||
          BigInt(storedPayout.reserveBeforeMinor) !==
            input.reserveBeforeMinor ||
          storedPayout.policyVersion !== input.policyVersion ||
          storedPayout.requestedBy !== input.requestedBy ||
          storedPayout.paidAt.getTime() !== input.paidAt.getTime() ||
          !ledgerEntry ||
          ledgerEntry.agentId !== input.agentId ||
          ledgerEntry.accountId !== input.accountId ||
          ledgerEntry.idempotencyKey !== ledgerIdempotencyKey ||
          ledgerEntry.amountMinor !== input.amountMinor ||
          ledgerEntry.assetCode !== input.assetCode ||
          ledgerEntry.assetClass !== input.assetClass ||
          !ledgerEntry.redeemable ||
          storedLedger?.destination !== input.destination ||
          storedLedger?.policyVersion !== input.policyVersion ||
          storedLedger?.externalReference !== input.externalReference
        ) {
          throw new OwnerPayoutAccountingConflictError(input.intentId);
        }

        return { payoutId: storedPayout.id, ledgerEntry };
      });
    },
  };
}
