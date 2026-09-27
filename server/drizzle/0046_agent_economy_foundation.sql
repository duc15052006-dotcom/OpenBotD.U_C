CREATE TABLE "agent_financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"asset_code" text NOT NULL,
	"asset_class" text NOT NULL,
	"provider" text DEFAULT 'internal' NOT NULL,
	"network" text DEFAULT 'none' NOT NULL,
	"redeemable" boolean DEFAULT false NOT NULL,
	"wallet_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_financial_accounts_asset_class_check" CHECK ("asset_class" IN ('FIAT','STABLECOIN','CRYPTO_OTHER','COMPUTE_CREDIT','INTERNAL_CREDIT','RECEIVABLE','PAYABLE'))
);
--> statement-breakpoint
CREATE TABLE "agent_financial_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"owner_share_bps" integer NOT NULL,
	"reinvestment_share_bps" integer NOT NULL,
	"reserve_share_bps" integer NOT NULL,
	"minimum_reserve_minor" numeric(30, 0) NOT NULL,
	"max_payment_per_transaction_minor" numeric(30, 0) NOT NULL,
	"max_hourly_spend_minor" numeric(30, 0) NOT NULL,
	"max_daily_spend_minor" numeric(30, 0) NOT NULL,
	"max_monthly_spend_minor" numeric(30, 0) NOT NULL,
	"owner_confirmation_threshold_minor" numeric(30, 0) NOT NULL,
	"max_child_funding_minor" numeric(30, 0) NOT NULL,
	"max_x402_payment_minor" numeric(30, 0) NOT NULL,
	"allowed_payment_addresses" text[] DEFAULT '{}' NOT NULL,
	"allowed_payment_categories" text[] DEFAULT '{}' NOT NULL,
	"allowed_x402_domains" text[] DEFAULT '{}' NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_financial_policies_shares_check" CHECK ("owner_share_bps" >= 0 AND "reinvestment_share_bps" >= 0 AND "reserve_share_bps" >= 0 AND "owner_share_bps" + "reinvestment_share_bps" + "reserve_share_bps" = 10000),
	CONSTRAINT "agent_financial_policies_limits_check" CHECK ("minimum_reserve_minor" >= 0 AND "max_payment_per_transaction_minor" >= 0 AND "max_hourly_spend_minor" >= 0 AND "max_daily_spend_minor" >= "max_hourly_spend_minor" AND "max_monthly_spend_minor" >= "max_daily_spend_minor" AND "owner_confirmation_threshold_minor" >= 0 AND "max_child_funding_minor" >= 0 AND "max_x402_payment_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"asset_class" text NOT NULL,
	"redeemable" boolean NOT NULL,
	"source" text,
	"destination" text,
	"purpose" text NOT NULL,
	"tool" text,
	"approval" text DEFAULT 'none' NOT NULL,
	"policy_version" integer,
	"external_reference" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ledger_entries_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "agent_ledger_entries_direction_check" CHECK ("direction" IN ('credit','debit')),
	CONSTRAINT "agent_ledger_entries_status_check" CHECK ("status" IN ('pending','settled','failed','reversed')),
	CONSTRAINT "agent_ledger_entries_asset_class_check" CHECK ("asset_class" IN ('FIAT','STABLECOIN','CRYPTO_OTHER','COMPUTE_CREDIT','INTERNAL_CREDIT','RECEIVABLE','PAYABLE'))
);
--> statement-breakpoint
ALTER TABLE "agent_financial_accounts" ADD CONSTRAINT "agent_financial_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_financial_policies" ADD CONSTRAINT "agent_financial_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_financial_accounts_agent_asset_provider_idx" ON "agent_financial_accounts" USING btree ("agent_id","asset_code","provider","network");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_financial_policies_agent_version_idx" ON "agent_financial_policies" USING btree ("agent_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ledger_entries_idempotency_idx" ON "agent_ledger_entries" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "agent_ledger_entries_agent_occurred_idx" ON "agent_ledger_entries" USING btree ("agent_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "agent_ledger_entries_account_occurred_idx" ON "agent_ledger_entries" USING btree ("account_id","occurred_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_agent_economy_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Agent Economy financial history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON "agent_ledger_entries"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_ledger_entries_no_truncate
BEFORE TRUNCATE ON "agent_ledger_entries"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_financial_policies_append_only
BEFORE UPDATE OR DELETE ON "agent_financial_policies"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_financial_policies_no_truncate
BEFORE TRUNCATE ON "agent_financial_policies"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
