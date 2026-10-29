CREATE TABLE "mix_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sheet_id" uuid,
	"employee_id" uuid,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mix_editors" (
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "mix_editors_company_id_employee_id_pk" PRIMARY KEY("company_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "mix_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_per_acre" double precision NOT NULL,
	"unit" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mix_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gallons_per_acre" double precision NOT NULL,
	"default_tank_gallons" double precision NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mix_changes" ADD CONSTRAINT "mix_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_changes" ADD CONSTRAINT "mix_changes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_editors" ADD CONSTRAINT "mix_editors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_editors" ADD CONSTRAINT "mix_editors_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_products" ADD CONSTRAINT "mix_products_sheet_id_mix_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."mix_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_sheets" ADD CONSTRAINT "mix_sheets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_sheets" ADD CONSTRAINT "mix_sheets_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mix_changes_sheet_idx" ON "mix_changes" USING btree ("sheet_id","created_at");