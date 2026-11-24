CREATE TABLE "product_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"cost_per_purchase_unit_cents" integer NOT NULL,
	"vendor" text,
	"effective_from" date NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_per_1000" double precision NOT NULL,
	"method" text DEFAULT 'truck_spray' NOT NULL,
	"carrier_gal_per_1000" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"manufacturer" text,
	"product_type" text DEFAULT 'other' NOT NULL,
	"formulation" text,
	"active_ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"epa_reg_no" text,
	"restricted_use" boolean DEFAULT false NOT NULL,
	"signal_word" text DEFAULT 'none' NOT NULL,
	"rei_hours" double precision,
	"targets" text,
	"use_unit" text NOT NULL,
	"purchase_unit_name" text,
	"purchase_unit_size" double precision,
	"label_max_per_1000" double precision,
	"label_max_per_year_per_1000" double precision,
	"label_instructions" text,
	"customer_note" text,
	"income_account_code" text,
	"cogs_account_code" text,
	"taxable" boolean DEFAULT false NOT NULL,
	"track_records" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_rates" ADD CONSTRAINT "product_rates_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_costs_product_idx" ON "product_costs" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE INDEX "product_rates_product_idx" ON "product_rates" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id","name");