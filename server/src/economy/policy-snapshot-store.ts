import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentFinancialAccounts,
  agentFinancialPolicies,
  agentLedgerEntries,
  agentPaymentReceipts,
  agentProfiles,
} from "../db/schema";
import type {
  PaymentIntentCreationSnapshot,
  PaymentIntentCreationSnapshotLoader,
} from "./payment-intent-creator";
import {
  summarizeAgentLedger,
  type AgentLedgerEntry,
  type AssetClass,
  type LedgerDirection,
  type LedgerEntryType,
  type LedgerStatus,
} from "./model";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

export class PaymentPolicySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentPolicySnapshotError";
  }
}

function parseBigint(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new PaymentPolicySnapshotError(
      `financial snapshot contains invalid ${field}`,
    );
  }
}

function ledgerType(value: string): LedgerEntryType {
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
      throw new PaymentPolicySnapshotError(
        "financial snapshot contains an unknown ledger entry type",
      );
  }
}

function ledgerDirection(value: string): LedgerDirection {
  if (value === "credit" || value === "debit") return value;
  throw new PaymentPolicySnapshotError(
    "financial snapshot contains an unknown ledger direction",
  );
}

function ledgerStatus(value: string): LedgerStatus {
  if (
    value === "pending" ||
    value === "settled" ||
    value === "failed" ||
    value === "reversed"
  ) {
    return value;
  }
  throw new PaymentPolicySnapshotError(
    "financial snapshot contains an unknown ledger status",
  );
}

function assetClass(value: string): AssetClass {
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
      throw new PaymentPolicySnapshotError(
        "financial snapshot contains an unknown asset class",
      );
  }
}

function ledgerEntry(row: {
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
    !row.id.trim() ||
    !row.agentId.trim() ||
    !row.accountId.trim() ||
    !row.idempotencyKey.trim() ||
    !row.assetCode.trim() ||
    Number.isNaN(row.occurredAt.getTime())
  ) {
    throw new PaymentPolicySnapshotError(
      "financial snapshot contains an invalid ledger row",
    );
  }
  const amountMinor = parseBigint(row.amountMinor, "ledger amount");
  if (amountMinor <= 0n) {
    throw new PaymentPolicySnapshotError(
      "financial snapshot contains a non-positive ledger amount",
    );
  }
  return {
    id: row.id,
    agentId: row.agentId,
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    type: ledgerType(row.type),
    direction: ledgerDirection(row.direction),
    status: ledgerStatus(row.status),
    amountMinor,
    assetCode: row.assetCode,
    assetClass: assetClass(row.assetClass),
    redeemable: row.redeemable,
    occurredAt: row.occurredAt,
  };
}

function settledBalanceFor(
  entries: readonly AgentLedgerEntry[],
  accountId: string,
): bigint {
  let balance = 0n;
  for (const entry of entries) {
    if (entry.accountId !== accountId || entry.status !== "settled") continue;
    balance +=
      entry.direction === "credit" ? entry.amountMinor : -entry.amountMinor;
  }
  return balance;
}

function sumVerifiedReceipts(
  rows: readonly { amountMinor: string; verifiedAt: Date }[],
  since: Date,
): bigint {
  let total = 0n;
  for (const row of rows) {
    if (Number.isNaN(row.verifiedAt.getTime())) {
      throw new PaymentPolicySnapshotError(
        "financial snapshot contains an invalid receipt timestamp",
      );
    }
    if (row.verifiedAt < since) continue;
    const amount = parseBigint(row.amountMinor, "payment receipt amount");
    if (amount <= 0n) {
      throw new PaymentPolicySnapshotError(
        "financial snapshot contains a non-positive receipt amount",
      );
    }
    total += amount;
  }
  return total;
}

export function createPaymentPolicySnapshotLoader(
  database: Database,
  now: () => Date = () => new Date(),
): PaymentIntentCreationSnapshotLoader {
  return async ({ agentId, accountId }): Promise<PaymentIntentCreationSnapshot> => {
    const normalizedAgentId = agentId.trim();
    const normalizedAccountId = accountId.trim();
    if (!normalizedAgentId || !normalizedAccountId) {
      throw new PaymentPolicySnapshotError(
        "Agent and financial account are required for a policy snapshot",
      );
    }

    const [account] = await database
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
          eq(agentFinancialAccounts.id, normalizedAccountId),
          eq(agentFinancialAccounts.agentId, normalizedAgentId),
        ),
      )
      .limit(1);

    if (!account?.profileAgentId || !account.assetCode.trim()) {
      throw new PaymentPolicySnapshotError(
        "financial account was not found for the active Agent",
      );
    }

    const [policy] = await database
      .select({
        version: agentFinancialPolicies.version,
        ownerShareBps: agentFinancialPolicies.ownerShareBps,
        reinvestmentShareBps: agentFinancialPolicies.reinvestmentShareBps,
        reserveShareBps: agentFinancialPolicies.reserveShareBps,
        minimumReserveMinor: agentFinancialPolicies.minimumReserveMinor,
        maxPaymentPerTransactionMinor:
          agentFinancialPolicies.maxPaymentPerTransactionMinor,
        maxHourlySpendMinor: agentFinancialPolicies.maxHourlySpendMinor,
        maxDailySpendMinor: agentFinancialPolicies.maxDailySpendMinor,
        maxMonthlySpendMinor: agentFinancialPolicies.maxMonthlySpendMinor,
        ownerConfirmationThresholdMinor:
          agentFinancialPolicies.ownerConfirmationThresholdMinor,
        maxChildFundingMinor: agentFinancialPolicies.maxChildFundingMinor,
        maxX402PaymentMinor: agentFinancialPolicies.maxX402PaymentMinor,
        allowedPaymentAddresses: agentFinancialPolicies.allowedPaymentAddresses,
        allowedPaymentCategories:
          agentFinancialPolicies.allowedPaymentCategories,
        allowedX402Domains: agentFinancialPolicies.allowedX402Domains,
        frozen: agentFinancialPolicies.frozen,
      })
      .from(agentFinancialPolicies)
      .where(eq(agentFinancialPolicies.agentId, normalizedAgentId))
      .orderBy(desc(agentFinancialPolicies.version))
      .limit(1);

    if (!policy || policy.version <= 0) {
      throw new PaymentPolicySnapshotError(
        "active financial policy was not found",
      );
    }

    const ledgerRows = await database
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
          eq(agentLedgerEntries.assetCode, account.assetCode),
        ),
      );

    const entries = ledgerRows.map(ledgerEntry);
    const pnl = summarizeAgentLedger(normalizedAgentId, entries);

    const current = now();
    if (Number.isNaN(current.getTime())) {
      throw new PaymentPolicySnapshotError(
        "financial snapshot clock is invalid",
      );
    }
    const monthStart = new Date(current.getTime() - MONTH_MS);
    const dayStart = new Date(current.getTime() - DAY_MS);
    const hourStart = new Date(current.getTime() - HOUR_MS);

    const receiptRows = await database
      .select({
        amountMinor: agentPaymentReceipts.amountMinor,
        verifiedAt: agentPaymentReceipts.verifiedAt,
      })
      .from(agentPaymentReceipts)
      .where(
        and(
          eq(agentPaymentReceipts.agentId, normalizedAgentId),
          eq(agentPaymentReceipts.assetCode, account.assetCode),
          eq(agentPaymentReceipts.providerStatus, "verified"),
          gte(agentPaymentReceipts.verifiedAt, monthStart),
        ),
      );

    return {
      version: policy.version,
      policy: {
        ownerShareBps: BigInt(policy.ownerShareBps),
        reinvestmentShareBps: BigInt(policy.reinvestmentShareBps),
        reserveShareBps: BigInt(policy.reserveShareBps),
        minimumReserveMinor: parseBigint(
          policy.minimumReserveMinor,
          "minimum reserve",
        ),
        maxPaymentPerTransactionMinor: parseBigint(
          policy.maxPaymentPerTransactionMinor,
          "per-transaction limit",
        ),
        maxHourlySpendMinor: parseBigint(
          policy.maxHourlySpendMinor,
          "hourly spend limit",
        ),
        maxDailySpendMinor: parseBigint(
          policy.maxDailySpendMinor,
          "daily spend limit",
        ),
        maxMonthlySpendMinor: parseBigint(
          policy.maxMonthlySpendMinor,
          "monthly spend limit",
        ),
        ownerConfirmationThresholdMinor: parseBigint(
          policy.ownerConfirmationThresholdMinor,
          "Owner confirmation threshold",
        ),
        maxChildFundingMinor: parseBigint(
          policy.maxChildFundingMinor,
          "child funding limit",
        ),
        maxX402PaymentMinor: parseBigint(
          policy.maxX402PaymentMinor,
          "x402 payment limit",
        ),
        allowedPaymentAddresses: policy.allowedPaymentAddresses,
        allowedPaymentCategories: policy.allowedPaymentCategories,
        allowedX402Domains: policy.allowedX402Domains,
        frozen: policy.frozen,
      },
      settledBalanceMinor: settledBalanceFor(entries, account.id),
      availableDistributableProfitMinor:
        pnl.availableDistributableProfitMinor,
      spend: {
        hourlyMinor: sumVerifiedReceipts(receiptRows, hourStart),
        dailyMinor: sumVerifiedReceipts(receiptRows, dayStart),
        monthlyMinor: sumVerifiedReceipts(receiptRows, monthStart),
      },
    };
  };
}
