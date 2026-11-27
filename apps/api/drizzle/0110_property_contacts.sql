CREATE TABLE "property_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"nickname" text,
	"name" text NOT NULL,
	"relation" text DEFAULT 'Tenant' NOT NULL,
	"email" text,
	"home_phone" text,
	"work_phone" text,
	"cell_phone" text,
	"other_phone" text,
	"fax" text,
	"phone" text,
	"form_of_contact" text,
	"birthday" date,
	"notes" text,
	"notify" boolean DEFAULT false NOT NULL,
	"text_opt_out_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chemical_notices" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "property_contacts" ADD CONSTRAINT "property_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_contacts" ADD CONSTRAINT "property_contacts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_contacts" ADD CONSTRAINT "property_contacts_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "property_contacts_property_idx" ON "property_contacts" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "property_contacts_company_idx" ON "property_contacts" USING btree ("company_id");