CREATE TYPE "public"."routine_schedule_kind" AS ENUM('recurring', 'once');--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "schedule_kind" routine_schedule_kind DEFAULT 'recurring' NOT NULL;
