CREATE TABLE "employee_permissions" (
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"area" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "employee_permissions_employee_id_area_pk" PRIMARY KEY("employee_id","area")
);
--> statement-breakpoint
ALTER TABLE "employee_permissions" ADD CONSTRAINT "employee_permissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_permissions" ADD CONSTRAINT "employee_permissions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;