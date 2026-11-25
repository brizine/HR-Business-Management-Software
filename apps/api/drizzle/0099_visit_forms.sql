CREATE TABLE "visit_form_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"form_id" uuid,
	"name" text NOT NULL,
	"def" jsonb NOT NULL,
	"answers" jsonb,
	"signature" jsonb,
	"submitted_by_id" uuid,
	"submitted_at" timestamp with time zone,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"def" jsonb NOT NULL,
	"auto_attach" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD CONSTRAINT "visit_form_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD CONSTRAINT "visit_form_entries_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD CONSTRAINT "visit_form_entries_form_id_visit_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."visit_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD CONSTRAINT "visit_form_entries_submitted_by_id_employees_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD CONSTRAINT "visit_form_entries_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_forms" ADD CONSTRAINT "visit_forms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_forms" ADD CONSTRAINT "visit_forms_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_forms" ADD CONSTRAINT "visit_forms_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_form_entries_visit_idx" ON "visit_form_entries" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_form_entries_form_idx" ON "visit_form_entries" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_form_entries_visit_form_idx" ON "visit_form_entries" USING btree ("visit_id","form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_forms_company_name_idx" ON "visit_forms" USING btree ("company_id",lower("name"));