ALTER TABLE "employees" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "status_changed_by_id" uuid;