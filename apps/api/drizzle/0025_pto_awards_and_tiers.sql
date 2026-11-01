ALTER TABLE "pto_policies" ADD COLUMN "grant_schedule" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "grant_date" text;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "grant_day_of_month" integer;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;