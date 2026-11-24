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
ALTER TABLE "companies" ADD COLUMN "pesticide_license_no" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "required_adjuvant" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "required_drift_agent" text;--> statement-breakpoint
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
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_uploaded_by_id_employees_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_record_changes_record_idx" ON "application_record_changes" USING btree ("record_id","seq");--> statement-breakpoint
CREATE INDEX "application_record_products_record_idx" ON "application_record_products" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "application_records_company_date_idx" ON "application_records" USING btree ("company_id","applied_on");--> statement-breakpoint
CREATE INDEX "application_records_visit_idx" ON "application_records" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "product_labels_product_idx" ON "product_labels" USING btree ("product_id","created_at");