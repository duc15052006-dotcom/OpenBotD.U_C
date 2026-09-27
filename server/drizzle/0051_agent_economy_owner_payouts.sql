CREATE TABLE "agent_payout_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"destination_credential_id" uuid NOT NULL,
	"threshold_minor" numeric(30, 0),
	"schedule" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payout_rules_mode_check" CHECK ("mode" IN ('manual','threshold','scheduled')),
	CONSTRAINT "agent_payout_rules_threshold_check" CHECK ("threshold_minor" IS NULL OR "threshold_minor" > 0),
	CONSTRAINT "agent_payout_rules_mode_fields_check" CHECK (
		("mode" = 'manual' AND "threshold_minor" IS NULL AND "schedule" IS NULL) OR
		("mode" = 'threshold' AND "threshold_minor" IS NOT NULL AND "schedule" IS NULL) OR
		("mode" = 'scheduled' AND "schedule" IS NOT NULL AND length(trim("schedule")) > 0)
	)
);
--> statement-breakpoint
CREATE TABLE "agent_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"asset_class" text NOT NULL,
	"destination" text NOT NULL,
	"policy_version" integer NOT NULL,
	"proof" jsonb NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payouts_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "agent_payouts_asset_class_check" CHECK ("asset_class" IN ('FIAT','STABLECOIN','CRYPTO_OTHER','COMPUTE_CREDIT','INTERNAL_CREDIT','RECEIVABLE','PAYABLE'))
);
--> statement-breakpoint
ALTER TABLE "agent_payout_rules" ADD CONSTRAINT "agent_payout_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payout_rules" ADD CONSTRAINT "agent_payout_rules_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payout_rules" ADD CONSTRAINT "agent_payout_rules_destination_credential_id_credentials_id_fk" FOREIGN KEY ("destination_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_rule_id_agent_payout_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."agent_payout_rules"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_receipt_id_agent_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."agent_payment_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payout_rules_agent_version_idx" ON "agent_payout_rules" USING btree ("agent_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payouts_intent_idx" ON "agent_payouts" USING btree ("intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payouts_receipt_idx" ON "agent_payouts" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX "agent_payouts_agent_paid_idx" ON "agent_payouts" USING btree ("agent_id","paid_at");
--> statement-breakpoint
CREATE TRIGGER agent_payout_rules_append_only
BEFORE UPDATE OR DELETE ON "agent_payout_rules"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payout_rules_no_truncate
BEFORE TRUNCATE ON "agent_payout_rules"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payouts_append_only
BEFORE UPDATE OR DELETE ON "agent_payouts"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payouts_no_truncate
BEFORE TRUNCATE ON "agent_payouts"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
