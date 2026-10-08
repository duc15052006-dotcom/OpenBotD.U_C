CREATE TYPE "public"."workflow_asset_direction" AS ENUM('input', 'output');--> statement-breakpoint
CREATE TYPE "public"."workflow_asset_media_kind" AS ENUM('image', 'video', 'audio', 'file', 'text');--> statement-breakpoint
CREATE TABLE "workflow_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"step_key" text NOT NULL,
	"direction" "workflow_asset_direction" NOT NULL,
	"media_kind" "workflow_asset_media_kind" NOT NULL,
	"ref" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_assets" ADD CONSTRAINT "workflow_assets_workflow_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_assets_step_ref_idx" ON "workflow_assets" USING btree ("workflow_id","step_key","direction","ref");--> statement-breakpoint
CREATE INDEX "workflow_assets_workflow_step_idx" ON "workflow_assets" USING btree ("workflow_id","step_key");
