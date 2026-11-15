CREATE TABLE "fuel_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"fuel_type" text NOT NULL,
	"quantity" double precision NOT NULL,
	"total_cost_cents" integer NOT NULL,
	"odometer" double precision,
	"hours" double precision,
	"full_tank" boolean DEFAULT true NOT NULL,
	"vendor" text,
	"notes" text,
	"receipt_key" text,
	"receipt_mime" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_price_cents" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_date" date;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_odometer" double precision;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purchase_hours" double precision;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_entries_asset_idx" ON "fuel_entries" USING btree ("asset_id","date");