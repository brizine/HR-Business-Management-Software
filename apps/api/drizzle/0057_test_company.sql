ALTER TABLE "companies" ADD COLUMN "test_of_company_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "linked_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_test_of_company_id_companies_id_fk" FOREIGN KEY ("test_of_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_linked_employee_id_employees_id_fk" FOREIGN KEY ("linked_employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;