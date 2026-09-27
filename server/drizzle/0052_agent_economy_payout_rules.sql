CREATE TABLE "agent_payout_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold_minor" numeric(30, 0) NOT NULL,
	"max_payout_minor" numeric(30, 0),
	"asset_code" text NOT NULL,
	"destination" text NOT NULL,
	"schedule" text,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payout_rules_mode_check" CHECK ("mode" IN ('threshold','scheduled')),
	CONSTRAINT "agent_payout_rules_threshold_check" CHECK ("threshold_minor" >= 0),
	CONSTRAINT "agent_payout_rules_max_check" CHECK ("max_payout_minor" IS NULL OR "max_payout_minor" > 0),
	CONSTRAINT "agent_payout_rules_schedule_check" CHECK ("mode" <> 'scheduled' OR ("schedule" IS NOT NULL AND length(trim("schedule")) > 0))
);
--> statement-breakpoint
ALTER TABLE "agent_payout_rules" ADD CONSTRAINT "agent_payout_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payout_rules" ADD CONSTRAINT "agent_payout_rules_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payout_rules_agent_key_version_idx" ON "agent_payout_rules" USING btree ("agent_id","rule_key","version");
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
