CREATE TABLE "visit_assignees" (
	"visit_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "visit_assignees_visit_id_employee_id_pk" PRIMARY KEY("visit_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "visit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"service_type_id" uuid,
	"description" text NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"budgeted_hours" double precision,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"color" text DEFAULT '#2563eb' NOT NULL,
	"location" text,
	"billing" text DEFAULT 'invoice' NOT NULL,
	"date" date,
	"end_date" date,
	"start_time" text,
	"end_time" text,
	"budgeted_hours" double precision,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"finished_by_id" uuid,
	"skip_reason" text,
	"notes" text,
	"completion_notes" text,
	"series_id" uuid,
	"repeat_label" text,
	"invoice_id" uuid,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit_assignees" ADD CONSTRAINT "visit_assignees_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_assignees" ADD CONSTRAINT "visit_assignees_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_lines" ADD CONSTRAINT "visit_lines_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_lines" ADD CONSTRAINT "visit_lines_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_finished_by_id_employees_id_fk" FOREIGN KEY ("finished_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_assignees_employee_idx" ON "visit_assignees" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "visit_lines_visit_idx" ON "visit_lines" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_company_number_idx" ON "visits" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "visits_company_date_idx" ON "visits" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "visits_customer_idx" ON "visits" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "visits_property_idx" ON "visits" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "visits_series_idx" ON "visits" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "visits_invoice_idx" ON "visits" USING btree ("invoice_id");