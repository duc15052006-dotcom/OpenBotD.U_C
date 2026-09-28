ALTER TABLE "agent_funding_relationships"
ADD COLUMN "child_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_funding_relationships"
ADD CONSTRAINT "agent_funding_relationships_child_account_id_agent_financial_accounts_id_fk"
FOREIGN KEY ("child_account_id")
REFERENCES "public"."agent_financial_accounts"("id")
ON DELETE restrict
ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_funding_relationships_child_account_idx"
ON "agent_funding_relationships" USING btree ("child_account_id");
