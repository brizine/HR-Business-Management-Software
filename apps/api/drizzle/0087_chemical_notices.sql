CREATE TABLE "chemical_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"to" text,
	"subject" text,
	"body" text NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"sent_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "chemical_notices" jsonb;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "chemical_notice" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD CONSTRAINT "chemical_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD CONSTRAINT "chemical_notices_record_id_application_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."application_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD CONSTRAINT "chemical_notices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD CONSTRAINT "chemical_notices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD CONSTRAINT "chemical_notices_sent_by_id_employees_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chemical_notices_company_idx" ON "chemical_notices" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "chemical_notices_record_idx" ON "chemical_notices" USING btree ("record_id");