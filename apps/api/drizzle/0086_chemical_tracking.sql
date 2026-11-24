CREATE TABLE "application_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gal_per_1000" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chemical_access" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_record_products" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "product_rates" ADD COLUMN "application_method_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "application_method_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "carrier_gal_per_1000" double precision;--> statement-breakpoint
ALTER TABLE "application_methods" ADD CONSTRAINT "application_methods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_methods" ADD CONSTRAINT "application_methods_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_access" ADD CONSTRAINT "chemical_access_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_access" ADD CONSTRAINT "chemical_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_access" ADD CONSTRAINT "chemical_access_added_by_id_employees_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_methods_company_idx" ON "application_methods" USING btree ("company_id","sort_order");--> statement-breakpoint
ALTER TABLE "product_rates" ADD CONSTRAINT "product_rates_application_method_id_application_methods_id_fk" FOREIGN KEY ("application_method_id") REFERENCES "public"."application_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_application_method_id_application_methods_id_fk" FOREIGN KEY ("application_method_id") REFERENCES "public"."application_methods"("id") ON DELETE set null ON UPDATE no action;