CREATE TABLE "sensitive_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"viewer_id" uuid,
	"employee_id" uuid,
	"tax_form_id" uuid,
	"action" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"data" text NOT NULL,
	"summary" text,
	"signed_name" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"signed_ip" text,
	"signed_user_agent" text,
	"employer_data" text,
	"employer_signed_name" text,
	"employer_signed_at" timestamp with time zone,
	"employer_signed_by_id" uuid,
	"processed_at" timestamp with time zone,
	"processed_by_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "ein" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tax_forms_in_crewdesk" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD COLUMN "form_type" text;--> statement-breakpoint
ALTER TABLE "sensitive_access_log" ADD CONSTRAINT "sensitive_access_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_access_log" ADD CONSTRAINT "sensitive_access_log_viewer_id_employees_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_access_log" ADD CONSTRAINT "sensitive_access_log_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_access_log" ADD CONSTRAINT "sensitive_access_log_tax_form_id_tax_forms_id_fk" FOREIGN KEY ("tax_form_id") REFERENCES "public"."tax_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_forms" ADD CONSTRAINT "tax_forms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_forms" ADD CONSTRAINT "tax_forms_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_forms" ADD CONSTRAINT "tax_forms_employer_signed_by_id_employees_id_fk" FOREIGN KEY ("employer_signed_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_forms" ADD CONSTRAINT "tax_forms_processed_by_id_employees_id_fk" FOREIGN KEY ("processed_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_forms_employee_idx" ON "tax_forms" USING btree ("employee_id","type");