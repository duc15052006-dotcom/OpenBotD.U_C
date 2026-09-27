ALTER TYPE "public"."credential_kind" ADD VALUE 'wallet';
--> statement-breakpoint
ALTER TABLE "agent_financial_accounts" ADD COLUMN "credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_financial_accounts" ADD CONSTRAINT "agent_financial_accounts_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_financial_accounts_credential_idx" ON "agent_financial_accounts" USING btree ("credential_id");
