CREATE TABLE "agent_funding_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_agent_id" text NOT NULL,
	"child_agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"budget_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_funding_relationships_distinct_agents_check" CHECK ("parent_agent_id" <> "child_agent_id"),
	CONSTRAINT "agent_funding_relationships_budget_check" CHECK ("budget_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_child_funding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"parent_agent_id" text NOT NULL,
	"child_agent_id" text NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"policy_version" integer NOT NULL,
	"funded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_child_funding_events_distinct_agents_check" CHECK ("parent_agent_id" <> "child_agent_id"),
	CONSTRAINT "agent_child_funding_events_amount_check" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_funding_relationships" ADD CONSTRAINT "agent_funding_relationships_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_funding_relationships" ADD CONSTRAINT "agent_funding_relationships_child_agent_id_agents_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_events" ADD CONSTRAINT "agent_child_funding_events_relationship_id_agent_funding_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."agent_funding_relationships"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_events" ADD CONSTRAINT "agent_child_funding_events_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_events" ADD CONSTRAINT "agent_child_funding_events_receipt_id_agent_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."agent_payment_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_events" ADD CONSTRAINT "agent_child_funding_events_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_events" ADD CONSTRAINT "agent_child_funding_events_child_agent_id_agents_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_funding_relationships_pair_version_idx" ON "agent_funding_relationships" USING btree ("parent_agent_id","child_agent_id","version");
--> statement-breakpoint
CREATE INDEX "agent_funding_relationships_child_idx" ON "agent_funding_relationships" USING btree ("child_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_child_funding_events_intent_idx" ON "agent_child_funding_events" USING btree ("intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_child_funding_events_receipt_idx" ON "agent_child_funding_events" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX "agent_child_funding_events_relationship_funded_idx" ON "agent_child_funding_events" USING btree ("relationship_id","funded_at");
--> statement-breakpoint
CREATE INDEX "agent_child_funding_events_child_funded_idx" ON "agent_child_funding_events" USING btree ("child_agent_id","funded_at");
--> statement-breakpoint
CREATE TRIGGER agent_funding_relationships_append_only
BEFORE UPDATE OR DELETE ON "agent_funding_relationships"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_funding_relationships_no_truncate
BEFORE TRUNCATE ON "agent_funding_relationships"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_child_funding_events_append_only
BEFORE UPDATE OR DELETE ON "agent_child_funding_events"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_child_funding_events_no_truncate
BEFORE TRUNCATE ON "agent_child_funding_events"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
