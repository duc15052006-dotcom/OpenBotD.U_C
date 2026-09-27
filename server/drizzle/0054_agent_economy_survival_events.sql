CREATE TABLE "agent_finance_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"settled_balance_minor" numeric(30, 0) NOT NULL,
	"minimum_reserve_minor" numeric(30, 0) NOT NULL,
	"model_cost_mode" text NOT NULL,
	"allow_optional_spend" boolean NOT NULL,
	"allow_child_funding" boolean NOT NULL,
	"alert_owner" boolean NOT NULL,
	"prioritize_revenue_work" boolean NOT NULL,
	"reason" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_finance_state_events_state_check" CHECK ("state" IN ('HEALTHY','LOW_RESERVE','CRITICAL','FROZEN','INSOLVENT')),
	CONSTRAINT "agent_finance_state_events_model_cost_mode_check" CHECK ("model_cost_mode" IN ('standard','economy','minimal')),
	CONSTRAINT "agent_finance_state_events_balance_check" CHECK ("minimum_reserve_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_finance_state_events" ADD CONSTRAINT "agent_finance_state_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_finance_state_events_idempotency_idx" ON "agent_finance_state_events" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "agent_finance_state_events_agent_observed_idx" ON "agent_finance_state_events" USING btree ("agent_id","observed_at");
--> statement-breakpoint
CREATE TRIGGER agent_finance_state_events_append_only
BEFORE UPDATE OR DELETE ON "agent_finance_state_events"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_finance_state_events_no_truncate
BEFORE TRUNCATE ON "agent_finance_state_events"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
