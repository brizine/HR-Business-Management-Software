CREATE TABLE "pay_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"pay_type" text NOT NULL,
	"pay_rate_cents" integer NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pay_periods" ADD COLUMN "approved_lines" jsonb;--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_rates_employee_date_idx" ON "pay_rates" USING btree ("employee_id","effective_date");--> statement-breakpoint
-- Everyone starts with their current pay as their first rate, covering all earlier dates.
INSERT INTO "pay_rates" ("company_id", "employee_id", "effective_date", "pay_type", "pay_rate_cents", "note")
SELECT "company_id", "id", COALESCE("start_date", '2000-01-01'), "pay_type", "pay_rate_cents", 'Starting rate' FROM "employees";
