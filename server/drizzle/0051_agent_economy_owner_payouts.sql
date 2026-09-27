CREATE TABLE "agent_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"asset_code" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"destination" text NOT NULL,
	"distributable_profit_before_minor" numeric(30, 0) NOT NULL,
	"reserve_before_minor" numeric(30, 0) NOT NULL,
	"policy_version" integer NOT NULL,
	"requested_by" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payouts_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "agent_payouts_mode_check" CHECK ("mode" IN ('manual','threshold','scheduled')),
	CONSTRAINT "agent_payouts_profit_check" CHECK ("distributable_profit_before_minor" >= "amount_minor"),
	CONSTRAINT "agent_payouts_reserve_check" CHECK ("reserve_before_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_receipt_id_agent_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."agent_payment_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payouts_intent_idx" ON "agent_payouts" USING btree ("intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payouts_receipt_idx" ON "agent_payouts" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX "agent_payouts_agent_paid_idx" ON "agent_payouts" USING btree ("agent_id","paid_at");
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
