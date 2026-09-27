import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const moneyMinor = (name: string) => numeric(name, { precision: 30, scale: 0 });

/**
 * One financially isolated account owned by one Agent.
 *
 * This stores only public/account-routing metadata. Private keys, seed phrases and provider
 * credentials belong in the protected credential boundary and must never appear here.
 */
export const agentFinancialAccounts = pgTable(
  "agent_financial_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    assetCode: text("asset_code").notNull(),
    assetClass: text("asset_class").notNull(),
    provider: text("provider").notNull().default("internal"),
    network: text("network").notNull().default("none"),
    redeemable: boolean("redeemable").notNull().default(false),
    walletReference: text("wallet_reference"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_financial_accounts_agent_asset_provider_idx").on(
      table.agentId,
      table.assetCode,
      table.provider,
      table.network,
    ),
  ],
);

/**
 * Versioned Owner policy. Rows are append-only at the database layer; the greatest version for an
 * Agent is the active policy. That keeps historical P&L and approvals attributable to the policy
 * that existed when the event happened.
 */
export const agentFinancialPolicies = pgTable(
  "agent_financial_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    ownerShareBps: integer("owner_share_bps").notNull(),
    reinvestmentShareBps: integer("reinvestment_share_bps").notNull(),
    reserveShareBps: integer("reserve_share_bps").notNull(),
    minimumReserveMinor: moneyMinor("minimum_reserve_minor").notNull(),
    maxPaymentPerTransactionMinor: moneyMinor(
      "max_payment_per_transaction_minor",
    ).notNull(),
    maxHourlySpendMinor: moneyMinor("max_hourly_spend_minor").notNull(),
    maxDailySpendMinor: moneyMinor("max_daily_spend_minor").notNull(),
    maxMonthlySpendMinor: moneyMinor("max_monthly_spend_minor").notNull(),
    ownerConfirmationThresholdMinor: moneyMinor(
      "owner_confirmation_threshold_minor",
    ).notNull(),
    maxChildFundingMinor: moneyMinor("max_child_funding_minor").notNull(),
    maxX402PaymentMinor: moneyMinor("max_x402_payment_minor").notNull(),
    allowedPaymentAddresses: text("allowed_payment_addresses")
      .array()
      .notNull()
      .default([]),
    allowedPaymentCategories: text("allowed_payment_categories")
      .array()
      .notNull()
      .default([]),
    allowedX402Domains: text("allowed_x402_domains")
      .array()
      .notNull()
      .default([]),
    frozen: boolean("frozen").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_financial_policies_agent_version_idx").on(
      table.agentId,
      table.version,
    ),
  ],
);

/**
 * Append-only accounting events.
 *
 * Amounts are integer minor units encoded as numeric(30,0), never floating-point values. Pending
 * and failed entries are retained for reconciliation but P&L projections count settled entries
 * only. Corrections are new compensating entries; historical rows are never edited in place.
 */
export const agentLedgerEntries = pgTable(
  "agent_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    type: text("type").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    amountMinor: moneyMinor("amount_minor").notNull(),
    assetCode: text("asset_code").notNull(),
    assetClass: text("asset_class").notNull(),
    redeemable: boolean("redeemable").notNull(),
    costCategory: text("cost_category"),
    projectId: text("project_id"),
    revenueAdapterId: text("revenue_adapter_id"),
    source: text("source"),
    destination: text("destination"),
    purpose: text("purpose").notNull(),
    tool: text("tool"),
    approval: text("approval").notNull().default("none"),
    policyVersion: integer("policy_version"),
    externalReference: text("external_reference"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_ledger_entries_idempotency_idx").on(
      table.idempotencyKey,
    ),
    index("agent_ledger_entries_agent_occurred_idx").on(
      table.agentId,
      table.occurredAt,
    ),
    index("agent_ledger_entries_account_occurred_idx").on(
      table.accountId,
      table.occurredAt,
    ),
    index("agent_ledger_entries_project_occurred_idx").on(
      table.projectId,
      table.occurredAt,
    ),
    index("agent_ledger_entries_revenue_adapter_occurred_idx").on(
      table.revenueAdapterId,
      table.occurredAt,
    ),
  ],
);
