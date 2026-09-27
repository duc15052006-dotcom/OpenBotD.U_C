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
import { agents, credentials } from "./core";
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
    /**
     * Pointer into the server credential vault for real payment adapters.
     *
     * Nullable for internal/mock accounts. The credential secret itself never enters an Economy row.
     */
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "restrict",
    }),
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

/**
 * Immutable record of a requested financial action and the server-side policy decision.
 *
 * E2 deliberately stops here: an ALLOW is permission to proceed to a later execution boundary, not
 * proof that money moved. E3 will add prepared transfers/receipts rather than mutating this record.
 */
export const agentPaymentIntents = pgTable(
  "agent_payment_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    amountMinor: moneyMinor("amount_minor").notNull(),
    destination: text("destination").notNull(),
    category: text("category").notNull(),
    x402Domain: text("x402_domain"),
    decision: text("decision").notNull(),
    decisionReason: text("decision_reason").notNull(),
    policyVersion: integer("policy_version").notNull(),
    initiatorKind: text("initiator_kind").notNull(),
    initiatorId: text("initiator_id"),
    metadata: jsonb("metadata").notNull().default({}),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_payment_intents_idempotency_idx").on(
      table.idempotencyKey,
    ),
    index("agent_payment_intents_agent_requested_idx").on(
      table.agentId,
      table.requestedAt,
    ),
  ],
);

/**
 * One final, verified external payment receipt.
 *
 * The row exists only after an adapter executes and independently verifies the transfer. Failures and
 * refusals belong in the audit trail; a receipt must never imply that a payment happened when it did
 * not. One intent can therefore produce at most one verified receipt.
 */
export const agentPaymentReceipts = pgTable(
  "agent_payment_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => agentPaymentIntents.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    externalReference: text("external_reference").notNull(),
    providerStatus: text("provider_status").notNull(),
    assetCode: text("asset_code").notNull(),
    amountMinor: moneyMinor("amount_minor").notNull(),
    destination: text("destination").notNull(),
    balanceBeforeMinor: moneyMinor("balance_before_minor"),
    balanceAfterMinor: moneyMinor("balance_after_minor"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_payment_receipts_intent_idx").on(table.intentId),
    uniqueIndex("agent_payment_receipts_provider_external_idx").on(
      table.provider,
      table.externalReference,
    ),
    index("agent_payment_receipts_agent_verified_idx").on(
      table.agentId,
      table.verifiedAt,
    ),
  ],
);

/**
 * One configured source of normalized revenue for an Agent.
 *
 * Secrets never live here. credentialId is only a pointer to the encrypted server vault; adapters
 * receive plaintext inside a scoped server-side factory just like payment adapters.
 */
export const revenueAdapters = pgTable(
  "revenue_adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    adapterKey: text("adapter_key").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "restrict",
    }),
    enabled: boolean("enabled").notNull().default(true),
    configuration: jsonb("configuration").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("revenue_adapters_agent_key_idx").on(
      table.agentId,
      table.adapterKey,
    ),
  ],
);

/**
 * Provider evidence normalized into one immutable revenue stream.
 *
 * Pending events stay visible for reconciliation but only settled, redeemable events are projected
 * into the accounting ledger. Provider retries collide on (adapter, external_event_id) instead of
 * double-counting income.
 */
export const revenueEvents = pgTable(
  "revenue_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapterId: uuid("adapter_id")
      .notNull()
      .references(() => revenueAdapters.id, { onDelete: "restrict" }),
    externalEventId: text("external_event_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    amountMinor: moneyMinor("amount_minor").notNull(),
    assetCode: text("asset_code").notNull(),
    assetClass: text("asset_class").notNull(),
    redeemable: boolean("redeemable").notNull(),
    source: text("source").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("revenue_events_adapter_external_status_idx").on(
      table.adapterId,
      table.externalEventId,
      table.status,
    ),
    index("revenue_events_agent_occurred_idx").on(
      table.agentId,
      table.occurredAt,
    ),
    index("revenue_events_account_occurred_idx").on(
      table.accountId,
      table.occurredAt,
    ),
  ],
);

/**
 * Immutable proof that an Owner payout was completed from distributable profit.
 *
 * Manual payout is E5a. Scheduled/threshold rules enqueue the same payout path later; they do not
 * get a second execution mechanism.
 */
export const agentPayouts = pgTable(
  "agent_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => agentPaymentIntents.id, { onDelete: "restrict" }),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => agentPaymentReceipts.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    mode: text("mode").notNull().default("manual"),
    assetCode: text("asset_code").notNull(),
    amountMinor: moneyMinor("amount_minor").notNull(),
    destination: text("destination").notNull(),
    distributableProfitBeforeMinor: moneyMinor(
      "distributable_profit_before_minor",
    ).notNull(),
    reserveBeforeMinor: moneyMinor("reserve_before_minor").notNull(),
    policyVersion: integer("policy_version").notNull(),
    requestedBy: text("requested_by").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_payouts_intent_idx").on(table.intentId),
    uniqueIndex("agent_payouts_receipt_idx").on(table.receiptId),
    index("agent_payouts_agent_paid_idx").on(table.agentId, table.paidAt),
  ],
);

/**
 * Versioned Owner payout automation rule.
 *
 * Historical versions are immutable. A scheduler claims durable work separately and then routes the
 * eligible amount through E5a, so automation never gets a privileged transfer path.
 */
export const agentPayoutRules = pgTable(
  "agent_payout_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => agentFinancialAccounts.id, { onDelete: "restrict" }),
    ruleKey: text("rule_key").notNull(),
    version: integer("version").notNull(),
    mode: text("mode").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    thresholdMinor: moneyMinor("threshold_minor").notNull(),
    maxPayoutMinor: moneyMinor("max_payout_minor"),
    assetCode: text("asset_code").notNull(),
    destination: text("destination").notNull(),
    schedule: text("schedule"),
    timezone: text("timezone"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_payout_rules_agent_key_version_idx").on(
      table.agentId,
      table.ruleKey,
      table.version,
    ),
  ],
);

/**
 * Versioned parent -> child funding policy.
 *
 * The relationship grants only a bounded funding path. It does not carry a wallet credential,
 * payment adapter or signing capability, so a child never inherits unrestricted parent authority.
 */
export const agentFundingRelationships = pgTable(
  "agent_funding_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentAgentId: text("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    childAgentId: text("child_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    budgetMinor: moneyMinor("budget_minor").notNull(),
    assetCode: text("asset_code").notNull(),
    active: boolean("active").notNull().default(true),
    frozen: boolean("frozen").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_funding_relationships_pair_version_idx").on(
      table.parentAgentId,
      table.childAgentId,
      table.version,
    ),
    index("agent_funding_relationships_child_idx").on(table.childAgentId),
  ],
);

/**
 * Immutable proof that parent funding actually completed through the normal payment boundary.
 *
 * Intent + verified receipt references prevent a relationship from claiming spend that never moved.
 */
export const agentChildFundingEvents = pgTable(
  "agent_child_funding_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => agentFundingRelationships.id, {
        onDelete: "restrict",
      }),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => agentPaymentIntents.id, { onDelete: "restrict" }),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => agentPaymentReceipts.id, { onDelete: "restrict" }),
    parentAgentId: text("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    childAgentId: text("child_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    amountMinor: moneyMinor("amount_minor").notNull(),
    assetCode: text("asset_code").notNull(),
    policyVersion: integer("policy_version").notNull(),
    fundedAt: timestamp("funded_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_child_funding_events_intent_idx").on(table.intentId),
    uniqueIndex("agent_child_funding_events_receipt_idx").on(table.receiptId),
    index("agent_child_funding_events_relationship_funded_idx").on(
      table.relationshipId,
      table.fundedAt,
    ),
    index("agent_child_funding_events_child_funded_idx").on(
      table.childAgentId,
      table.fundedAt,
    ),
  ],
);

/**
 * Immutable observation emitted by a finance heartbeat.
 *
 * The event records the controls selected from current balance/reserve state. Scheduling uses the
 * existing durable work_items queue; this table is history/audit, not a timer.
 */
export const agentFinanceStateEvents = pgTable(
  "agent_finance_state_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull(),
    settledBalanceMinor: moneyMinor("settled_balance_minor").notNull(),
    minimumReserveMinor: moneyMinor("minimum_reserve_minor").notNull(),
    modelCostMode: text("model_cost_mode").notNull(),
    allowOptionalSpend: boolean("allow_optional_spend").notNull(),
    allowChildFunding: boolean("allow_child_funding").notNull(),
    alertOwner: boolean("alert_owner").notNull(),
    prioritizeRevenueWork: boolean("prioritize_revenue_work").notNull(),
    reason: text("reason").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_finance_state_events_idempotency_idx").on(
      table.idempotencyKey,
    ),
    index("agent_finance_state_events_agent_observed_idx").on(
      table.agentId,
      table.observedAt,
    ),
  ],
);

