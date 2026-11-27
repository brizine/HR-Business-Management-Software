ALTER TABLE "estimate_lines" ADD COLUMN "lawn_area" text DEFAULT 'whole' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN "lawn_area_sq_ft" double precision;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "lawn_area" text DEFAULT 'whole' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "lawn_area_sq_ft" double precision;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "default_lawn_area" text DEFAULT 'whole' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_lines" ADD COLUMN "lawn_area" text DEFAULT 'whole' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_lines" ADD COLUMN "lawn_area_sq_ft" double precision;