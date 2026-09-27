CREATE TABLE "agent_payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"destination" text NOT NULL,
	"category" text NOT NULL,
	"x402_domain" text,
	"decision" text NOT NULL,
	"decision_reason" text NOT NULL,
	"policy_version" integer NOT NULL,
	"initiator_kind" text NOT NULL,
	"initiator_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payment_intents_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "agent_payment_intents_kind_check" CHECK ("kind" IN ('OPERATING_EXPENSE','OWNER_PAYOUT','CHILD_FUNDING','X402_PAYMENT')),
	CONSTRAINT "agent_payment_intents_decision_check" CHECK ("decision" IN ('ALLOW','OWNER_CONFIRMATION','DENY')),
	CONSTRAINT "agent_payment_intents_initiator_check" CHECK ("initiator_kind" IN ('person','deployment','routine','handoff'))
);
--> statement-breakpoint
ALTER TABLE "agent_payment_intents" ADD CONSTRAINT "agent_payment_intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payment_intents" ADD CONSTRAINT "agent_payment_intents_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payment_intents_idempotency_idx" ON "agent_payment_intents" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "agent_payment_intents_agent_requested_idx" ON "agent_payment_intents" USING btree ("agent_id","requested_at");
--> statement-breakpoint
CREATE TRIGGER agent_payment_intents_append_only
BEFORE UPDATE OR DELETE ON "agent_payment_intents"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payment_intents_no_truncate
BEFORE TRUNCATE ON "agent_payment_intents"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
