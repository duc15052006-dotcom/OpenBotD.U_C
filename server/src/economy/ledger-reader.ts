import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentLedgerEntries } from "../db/schema";
import type {
  AgentLedgerEntry,
  AssetClass,
  LedgerDirection,
  LedgerEntryType,
  LedgerStatus,
} from "./model";

export class LedgerReadIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerReadIntegrityError";
  }
}

export interface AgentLedgerReader {
  loadAgentAsset(input: {
    agentId: string;
    assetCode: string;
  }): Promise<AgentLedgerEntry[]>;
}

function parseType(value: string): LedgerEntryType {
  switch (value) {
    case "revenue":
    case "revenue_reversal":
    case "operating_cost":
    case "reserve_allocation":
    case "reinvestment":
    case "owner_payout":
    case "investment":
    case "adjustment":
      return value;
    default:
      throw new LedgerReadIntegrityError("ledger contains an unknown entry type");
  }
}

function parseDirection(value: string): LedgerDirection {
  if (value === "credit" || value === "debit") return value;
  throw new LedgerReadIntegrityError("ledger contains an unknown direction");
}

function parseStatus(value: string): LedgerStatus {
  if (
    value === "pending" ||
    value === "settled" ||
    value === "failed" ||
    value === "reversed"
  ) {
    return value;
  }
  throw new LedgerReadIntegrityError("ledger contains an unknown status");
}

function parseAssetClass(value: string): AssetClass {
  switch (value) {
    case "FIAT":
    case "STABLECOIN":
    case "CRYPTO_OTHER":
    case "COMPUTE_CREDIT":
    case "INTERNAL_CREDIT":
    case "RECEIVABLE":
    case "PAYABLE":
      return value;
    default:
      throw new LedgerReadIntegrityError("ledger contains an unknown asset class");
  }
}

function parseAmount(value: string): bigint {
  try {
    const amount = BigInt(value);
    if (amount <= 0n) throw new Error("non-positive");
    return amount;
  } catch {
    throw new LedgerReadIntegrityError("ledger contains an invalid amount");
  }
}

export function createAgentLedgerReader(database: Database): AgentLedgerReader {
  return {
    async loadAgentAsset({ agentId, assetCode }) {
      const normalizedAgentId = agentId.trim();
      const normalizedAssetCode = assetCode.trim();
      if (!normalizedAgentId || !normalizedAssetCode) {
        throw new LedgerReadIntegrityError(
          "Agent and asset are required to read ledger history",
        );
      }

      const rows = await database
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
        .where(
          and(
            eq(agentLedgerEntries.agentId, normalizedAgentId),
            eq(agentLedgerEntries.assetCode, normalizedAssetCode),
          ),
        );

      return rows.map((row) => {
        if (
          !row.id.trim() ||
          !row.agentId.trim() ||
          !row.accountId.trim() ||
          !row.idempotencyKey.trim() ||
          !row.assetCode.trim() ||
          row.agentId !== normalizedAgentId ||
          row.assetCode !== normalizedAssetCode ||
          Number.isNaN(row.occurredAt.getTime())
        ) {
          throw new LedgerReadIntegrityError(
            "ledger contains an invalid durable row",
          );
        }

        return {
          id: row.id,
          agentId: row.agentId,
          accountId: row.accountId,
          idempotencyKey: row.idempotencyKey,
          type: parseType(row.type),
          direction: parseDirection(row.direction),
          status: parseStatus(row.status),
          amountMinor: parseAmount(row.amountMinor),
          assetCode: row.assetCode,
          assetClass: parseAssetClass(row.assetClass),
          redeemable: row.redeemable,
          occurredAt: row.occurredAt,
        };
      });
    },
  };
}
