CREATE TABLE "agent_child_funding_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"parent_agent_id" text NOT NULL,
	"parent_account_id" uuid NOT NULL,
	"child_agent_id" text NOT NULL,
	"child_account_id" uuid NOT NULL,
	"amount_minor" numeric(30, 0) NOT NULL,
	"asset_code" text NOT NULL,
	"policy_version" integer NOT NULL,
	"reserved_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_child_funding_reservations_distinct_agents_check" CHECK ("parent_agent_id" <> "child_agent_id"),
	CONSTRAINT "agent_child_funding_reservations_amount_check" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_relationship_id_agent_funding_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."agent_funding_relationships"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_parent_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_child_agent_id_agents_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_child_funding_reservations" ADD CONSTRAINT "agent_child_funding_reservations_child_account_id_agent_financial_accounts_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."agent_financial_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_child_funding_reservations_intent_idx" ON "agent_child_funding_reservations" USING btree ("intent_id");
--> statement-breakpoint
CREATE INDEX "agent_child_funding_reservations_relationship_until_idx" ON "agent_child_funding_reservations" USING btree ("relationship_id","reserved_until");
--> statement-breakpoint
CREATE INDEX "agent_child_funding_reservations_child_idx" ON "agent_child_funding_reservations" USING btree ("child_agent_id","created_at");
--> statement-breakpoint
CREATE TRIGGER agent_child_funding_reservations_append_only
BEFORE UPDATE OR DELETE ON "agent_child_funding_reservations"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_child_funding_reservations_no_truncate
BEFORE TRUNCATE ON "agent_child_funding_reservations"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
