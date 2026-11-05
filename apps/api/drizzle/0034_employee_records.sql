CREATE TABLE "employee_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"date" date NOT NULL,
	"period_start" date,
	"period_end" date,
	"rating" integer,
	"strengths" text,
	"improvements" text,
	"goals" text,
	"reason" text,
	"incident_date" date,
	"expectations" text,
	"follow_up_date" date,
	"summary" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"shared_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"employee_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_records" ADD CONSTRAINT "employee_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_records" ADD CONSTRAINT "employee_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_records" ADD CONSTRAINT "employee_records_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_records_employee_idx" ON "employee_records" USING btree ("employee_id");