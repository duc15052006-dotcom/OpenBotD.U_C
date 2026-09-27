ALTER TYPE "public"."credential_kind" ADD VALUE 'payment';
--> statement-breakpoint
ALTER TABLE "agent_financial_accounts" ADD COLUMN "credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_financial_accounts" ADD CONSTRAINT "agent_financial_accounts_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "agent_payment_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_reference" text NOT NULL,
	"provider_status" text NOT NULL,
	"asset_code" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"destination" text NOT NULL,
	"balance_before_minor" numeric(30, 0),
	"balance_after_minor" numeric(30, 0),
	"verified_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payment_receipts_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "agent_payment_receipts_verified_check" CHECK ("provider_status" = 'verified'),
	CONSTRAINT "agent_payment_receipts_balance_before_check" CHECK ("balance_before_minor" IS NULL OR "balance_before_minor" >= 0),
	CONSTRAINT "agent_payment_receipts_balance_after_check" CHECK ("balance_after_minor" IS NULL OR "balance_after_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_payment_receipts" ADD CONSTRAINT "agent_payment_receipts_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payment_receipts" ADD CONSTRAINT "agent_payment_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payment_receipts" ADD CONSTRAINT "agent_payment_receipts_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payment_receipts_intent_idx" ON "agent_payment_receipts" USING btree ("intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payment_receipts_provider_external_idx" ON "agent_payment_receipts" USING btree ("provider","external_reference");
--> statement-breakpoint
CREATE INDEX "agent_payment_receipts_agent_verified_idx" ON "agent_payment_receipts" USING btree ("agent_id","verified_at");
--> statement-breakpoint
CREATE TRIGGER agent_payment_receipts_append_only
BEFORE UPDATE OR DELETE ON "agent_payment_receipts"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payment_receipts_no_truncate
BEFORE TRUNCATE ON "agent_payment_receipts"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
