CREATE TABLE "application_record_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"employee_id" uuid,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_record_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"product_id" uuid,
	"trade_name" text NOT NULL,
	"epa_reg_no" text,
	"product_type" text,
	"restricted_use" boolean DEFAULT false NOT NULL,
	"rate_name" text,
	"rate_per_1000" double precision NOT NULL,
	"unit" text NOT NULL,
	"dilution_per_gal" double precision,
	"carrier_gal_per_1000" double precision,
	"amount" double precision NOT NULL,
	"targets" text,
	"rei_hours" double precision,
	"label_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid,
	"visit_number" integer,
	"company_name" text NOT NULL,
	"company_address" text,
	"company_license_no" text,
	"applicator_id" uuid,
	"applicator_name" text NOT NULL,
	"applicator_cert_no" text,
	"applicator_cert_expires" date,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"customer_address" text,
	"property_id" uuid,
	"site_address" text,
	"applied_on" date NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"site" text,
	"area_sq_ft" double precision,
	"tank_mix_gal" double precision,
	"lat" double precision,
	"lng" double precision,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applicator_certs" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"cert_no" text NOT NULL,
	"expires_on" date NOT NULL,
	"categories" text,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "product_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"caption" text,
	"uploaded_by_id" uuid,
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
	"required_adjuvant" text,
	"required_drift_agent" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_type_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_rate_id" uuid NOT NULL,
	"start_date" date,
	"end_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"service_type_id" uuid,
	"product_id" uuid,
	"product_rate_id" uuid,
	"product_cost_id" uuid,
	"product_name" text NOT NULL,
	"epa_reg_no" text,
	"rate_name" text,
	"amount_per_1000" double precision NOT NULL,
	"area_sq_ft" double precision NOT NULL,
	"amount" double precision NOT NULL,
	"unit" text NOT NULL,
	"cost_per_use_unit_cents" double precision,
	"cost_cents" integer,
	"cost_date" date NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pesticide_license_no" text;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "band_size_sq_ft" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "band_price_point" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "round_to_cents" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "max_auto_sq_ft" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "target_cents_per_hour" integer;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "application_site" text;--> statement-breakpoint
ALTER TABLE "application_record_changes" ADD CONSTRAINT "application_record_changes_record_id_application_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."application_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_record_changes" ADD CONSTRAINT "application_record_changes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_record_products" ADD CONSTRAINT "application_record_products_record_id_application_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."application_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_record_products" ADD CONSTRAINT "application_record_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_record_products" ADD CONSTRAINT "application_record_products_label_id_product_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."product_labels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_applicator_id_employees_id_fk" FOREIGN KEY ("applicator_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicator_certs" ADD CONSTRAINT "applicator_certs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicator_certs" ADD CONSTRAINT "applicator_certs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicator_certs" ADD CONSTRAINT "applicator_certs_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_uploaded_by_id_employees_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_rates" ADD CONSTRAINT "product_rates_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_product_rate_id_product_rates_id_fk" FOREIGN KEY ("product_rate_id") REFERENCES "public"."product_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_rate_id_product_rates_id_fk" FOREIGN KEY ("product_rate_id") REFERENCES "public"."product_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_cost_id_product_costs_id_fk" FOREIGN KEY ("product_cost_id") REFERENCES "public"."product_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_record_changes_record_idx" ON "application_record_changes" USING btree ("record_id","seq");--> statement-breakpoint
CREATE INDEX "application_record_products_record_idx" ON "application_record_products" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "application_records_company_date_idx" ON "application_records" USING btree ("company_id","applied_on");--> statement-breakpoint
CREATE INDEX "application_records_visit_idx" ON "application_records" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "product_costs_product_idx" ON "product_costs" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE INDEX "product_labels_product_idx" ON "product_labels" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "product_rates_product_idx" ON "product_rates" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "service_products_service_idx" ON "service_products" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "service_products_rate_idx" ON "service_products" USING btree ("product_rate_id");--> statement-breakpoint
CREATE INDEX "visit_products_visit_idx" ON "visit_products" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_products_company_product_idx" ON "visit_products" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "visit_products_cost_idx" ON "visit_products" USING btree ("product_cost_id");