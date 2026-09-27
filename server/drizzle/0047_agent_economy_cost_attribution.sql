ALTER TABLE "agent_ledger_entries" ADD COLUMN "cost_category" text;
--> statement-breakpoint
ALTER TABLE "agent_ledger_entries" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "agent_ledger_entries" ADD COLUMN "revenue_adapter_id" text;
--> statement-breakpoint
CREATE INDEX "agent_ledger_entries_project_occurred_idx" ON "agent_ledger_entries" USING btree ("project_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "agent_ledger_entries_revenue_adapter_occurred_idx" ON "agent_ledger_entries" USING btree ("revenue_adapter_id","occurred_at");
