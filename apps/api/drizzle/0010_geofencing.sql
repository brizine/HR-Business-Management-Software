CREATE TABLE "job_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_meters" integer DEFAULT 150 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "clock_in_location" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "clock_out_location" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_in_accuracy" double precision;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_out_accuracy" double precision;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_in_site_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_out_site_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_in_distance" double precision;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_out_distance" double precision;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_in_flag" text;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "clock_out_flag" text;--> statement-breakpoint
ALTER TABLE "job_sites" ADD CONSTRAINT "job_sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;