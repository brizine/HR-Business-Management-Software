CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crews" ADD COLUMN "daily_hours" double precision DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "notify_before" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "card_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "card_exempt_by_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "card_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "preferred_crew_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "notify_before" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "card_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "card_exempt_by_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "card_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "setup_minutes" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "minutes_per_1000" double precision;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "release_on" date;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "due_by" date;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "min_days_after_last" integer;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "early_reason" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "early_by_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "early_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "window_start" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "window_end" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "back_reason" text;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_employees_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_company_page_idx" ON "saved_views" USING btree ("company_id","page");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_early_by_id_employees_id_fk" FOREIGN KEY ("early_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "visits" SET "waiting_since" = "created_at" WHERE "date" IS NULL AND "waiting_since" IS NULL;
