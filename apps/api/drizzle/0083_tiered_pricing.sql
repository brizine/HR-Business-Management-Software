ALTER TABLE "service_types" ADD COLUMN "tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "band_size_sq_ft" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "band_price_point" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "round_to_cents" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "max_auto_sq_ft" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "target_cents_per_hour" integer;