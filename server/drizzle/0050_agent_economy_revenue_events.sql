CREATE TABLE "revenue_adapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"adapter_key" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"credential_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_id" uuid NOT NULL,
	"external_event_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"asset_class" text NOT NULL,
	"redeemable" boolean NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_events_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "revenue_events_status_check" CHECK ("status" IN ('pending','settled','failed','reversed')),
	CONSTRAINT "revenue_events_asset_class_check" CHECK ("asset_class" IN ('FIAT','STABLECOIN','CRYPTO_OTHER','COMPUTE_CREDIT','INTERNAL_CREDIT','RECEIVABLE','PAYABLE')),
	CONSTRAINT "revenue_events_settled_at_check" CHECK ("status" <> 'settled' OR "settled_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "revenue_adapters" ADD CONSTRAINT "revenue_adapters_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revenue_adapters" ADD CONSTRAINT "revenue_adapters_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_adapter_id_revenue_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."revenue_adapters"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_adapters_agent_key_idx" ON "revenue_adapters" USING btree ("agent_id","adapter_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_events_adapter_external_status_idx" ON "revenue_events" USING btree ("adapter_id","external_event_id","status");
--> statement-breakpoint
CREATE INDEX "revenue_events_agent_occurred_idx" ON "revenue_events" USING btree ("agent_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "revenue_events_account_occurred_idx" ON "revenue_events" USING btree ("account_id","occurred_at");
--> statement-breakpoint
CREATE TRIGGER revenue_events_append_only
BEFORE UPDATE OR DELETE ON "revenue_events"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER revenue_events_no_truncate
BEFORE TRUNCATE ON "revenue_events"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
