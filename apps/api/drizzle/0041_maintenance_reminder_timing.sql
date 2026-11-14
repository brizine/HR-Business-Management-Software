ALTER TABLE "companies" ADD COLUMN "fleet_settings" jsonb;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD COLUMN "remind_miles_before" double precision;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD COLUMN "remind_hours_before" double precision;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD COLUMN "remind_days_before" integer;