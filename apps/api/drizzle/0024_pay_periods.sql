CREATE TABLE "pay_period_approvers" (
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "pay_period_approvers_company_id_employee_id_pk" PRIMARY KEY("company_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "pay_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"payday" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pay_frequency" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pay_period_anchor" date;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payday_offset_days" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_period_approvers" ADD CONSTRAINT "pay_period_approvers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_period_approvers" ADD CONSTRAINT "pay_period_approvers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_approved_by_id_employees_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_periods_company_start_idx" ON "pay_periods" USING btree ("company_id","period_start");