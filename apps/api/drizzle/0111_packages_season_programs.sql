CREATE TABLE "property_package_rounds" (
	"property_package_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"unit_price_cents" integer,
	"budgeted_hours" double precision,
	CONSTRAINT "property_package_rounds_property_package_id_round_id_pk" PRIMARY KEY("property_package_id","round_id")
);
--> statement-breakpoint
CREATE TABLE "property_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"package_id" uuid,
	"package_name" text NOT NULL,
	"renewal" text DEFAULT 'auto' NOT NULL,
	"crew_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"started_on" date NOT NULL,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_lines" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "package_lines" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "package_lines" ADD COLUMN "min_days" integer;--> statement-breakpoint
ALTER TABLE "package_lines" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "renewal_date" date;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "property_package_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "package_round_id" uuid;--> statement-breakpoint
ALTER TABLE "property_package_rounds" ADD CONSTRAINT "property_package_rounds_property_package_id_property_packages_id_fk" FOREIGN KEY ("property_package_id") REFERENCES "public"."property_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_package_rounds" ADD CONSTRAINT "property_package_rounds_round_id_package_lines_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."package_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_packages" ADD CONSTRAINT "property_packages_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "property_packages_property_idx" ON "property_packages" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "property_packages_package_idx" ON "property_packages" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "property_packages_company_idx" ON "property_packages" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_property_package_id_property_packages_id_fk" FOREIGN KEY ("property_package_id") REFERENCES "public"."property_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_package_round_id_package_lines_id_fk" FOREIGN KEY ("package_round_id") REFERENCES "public"."package_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visits_property_package_idx" ON "visits" USING btree ("property_package_id");--> statement-breakpoint
-- The old packages were bundles of line items for one work order. They stay, switched off, until an admin gives their rounds windows or deletes them.
UPDATE "packages" SET "active" = false;
