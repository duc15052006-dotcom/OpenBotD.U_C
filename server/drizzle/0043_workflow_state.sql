CREATE TYPE "public"."workflow_run_status" AS ENUM('active', 'paused', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workflow_step_status" AS ENUM('blocked', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "workflow_run_status" DEFAULT 'active' NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"instruction" text NOT NULL,
	"depends_on" text[] DEFAULT '{}' NOT NULL,
	"status" "workflow_step_status" DEFAULT 'blocked' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"wait_until" timestamp with time zone,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_owner_status_idx" ON "workflow_runs" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "workflow_runs_agent_status_idx" ON "workflow_runs" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_workflow_key_idx" ON "workflow_steps" USING btree ("workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_steps_workflow_position_idx" ON "workflow_steps" USING btree ("workflow_id","position");--> statement-breakpoint
CREATE INDEX "workflow_steps_status_wait_idx" ON "workflow_steps" USING btree ("status","wait_until");