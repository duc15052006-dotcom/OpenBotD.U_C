CREATE TABLE "agent_payment_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"approver_kind" text NOT NULL,
	"approver_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_payment_approvals_policy_version_check" CHECK ("policy_version" > 0),
	CONSTRAINT "agent_payment_approvals_owner_only_check" CHECK ("approver_kind" = 'OWNER'),
	CONSTRAINT "agent_payment_approvals_approver_id_check" CHECK (length(btrim("approver_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_payment_approvals" ADD CONSTRAINT "agent_payment_approvals_intent_id_agent_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."agent_payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_payment_approvals" ADD CONSTRAINT "agent_payment_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payment_approvals_intent_idx" ON "agent_payment_approvals" USING btree ("intent_id");
--> statement-breakpoint
CREATE INDEX "agent_payment_approvals_agent_approved_idx" ON "agent_payment_approvals" USING btree ("agent_id","approved_at");
--> statement-breakpoint
CREATE TRIGGER agent_payment_approvals_append_only
BEFORE UPDATE OR DELETE ON "agent_payment_approvals"
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_payment_approvals_no_truncate
BEFORE TRUNCATE ON "agent_payment_approvals"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_agent_economy_history_mutation();
