CREATE TABLE "cancellation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"initiated_by" text DEFAULT 'customer' NOT NULL,
	"comment_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"reason_id" uuid,
	"reason_label" text NOT NULL,
	"effective_date" date NOT NULL,
	"comment" text,
	"by_id" uuid,
	"reactivated_at" timestamp with time zone,
	"reactivated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"description" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relation" text,
	"email" text,
	"phone" text,
	"gets_invoices" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text DEFAULT 'residential' NOT NULL,
	"first_name" text,
	"last_name" text,
	"company_name" text,
	"email" text,
	"phone" text,
	"alt_phone" text,
	"billing_street" text,
	"billing_city" text,
	"billing_state" text DEFAULT 'OK' NOT NULL,
	"billing_zip" text,
	"delivery" text[] DEFAULT ARRAY['email']::text[] NOT NULL,
	"source" text,
	"po_required" boolean DEFAULT false NOT NULL,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tag_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"sample" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"bigcapital_customer_id" integer,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text,
	"street" text NOT NULL,
	"city" text,
	"state" text DEFAULT 'OK' NOT NULL,
	"zip" text,
	"lat" double precision,
	"lng" double precision,
	"map_code" text,
	"map_code_manual" boolean DEFAULT false NOT NULL,
	"lawn_sq_ft" double precision,
	"front_sq_ft" double precision,
	"back_sq_ft" double precision,
	"measurement_id" uuid,
	"gate_code" text,
	"pets" text,
	"access_notes" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tag_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"sample" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"role" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"action" text NOT NULL,
	"source" text DEFAULT 'hand' NOT NULL,
	"by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cancellation_reasons" ADD CONSTRAINT "cancellation_reasons_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_reason_id_cancellation_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."cancellation_reasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_by_id_employees_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_reactivated_by_id_employees_id_fk" FOREIGN KEY ("reactivated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tags" ADD CONSTRAINT "crm_tags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_measurement_id_measurements_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public"."measurements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_assignments" ADD CONSTRAINT "property_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_assignments" ADD CONSTRAINT "property_assignments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_assignments" ADD CONSTRAINT "property_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_tag_id_crm_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."crm_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_by_id_employees_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cancellation_reasons_company_idx" ON "cancellation_reasons" USING btree ("company_id","sort_order");--> statement-breakpoint
CREATE INDEX "cancellations_company_idx" ON "cancellations" USING btree ("company_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_tags_company_name_idx" ON "crm_tags" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_number_idx" ON "customers" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "customers_company_status_idx" ON "customers" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "customers_tags_idx" ON "customers" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "properties_company_status_idx" ON "properties" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "properties_company_map_code_idx" ON "properties" USING btree ("company_id","map_code");--> statement-breakpoint
CREATE INDEX "properties_tags_idx" ON "properties" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "property_assignments_property_idx" ON "property_assignments" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "property_assignments_customer_idx" ON "property_assignments" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_assignments_one_bill_to_idx" ON "property_assignments" USING btree ("property_id") WHERE "property_assignments"."role" = 'bill_to' and "property_assignments"."end_date" is null;--> statement-breakpoint
CREATE INDEX "tag_events_company_idx" ON "tag_events" USING btree ("company_id","created_at");