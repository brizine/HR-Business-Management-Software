CREATE TABLE "notification_preferences" (
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"category" text NOT NULL,
	"app" boolean DEFAULT true NOT NULL,
	"email" text DEFAULT 'no_app' NOT NULL,
	"sms" text DEFAULT 'never' NOT NULL,
	CONSTRAINT "notification_preferences_employee_id_category_pk" PRIMARY KEY("employee_id","category")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "sms_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "sms_opt_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;