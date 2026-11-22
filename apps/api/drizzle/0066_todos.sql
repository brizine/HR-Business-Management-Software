CREATE TABLE "todo_assignees" (
	"todo_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "todo_assignees_todo_id_employee_id_pk" PRIMARY KEY("todo_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"customer_id" uuid,
	"property_id" uuid,
	"location" text,
	"color" text DEFAULT '#2563eb' NOT NULL,
	"date" date NOT NULL,
	"end_date" date,
	"start_time" text,
	"end_time" text,
	"budgeted_hours" double precision,
	"series_id" uuid,
	"repeat" text DEFAULT 'none' NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_id" uuid,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todo_assignees" ADD CONSTRAINT "todo_assignees_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_assignees" ADD CONSTRAINT "todo_assignees_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_done_by_id_employees_id_fk" FOREIGN KEY ("done_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todo_assignees_employee_idx" ON "todo_assignees" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "todos_company_date_idx" ON "todos" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "todos_series_idx" ON "todos" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "todos_customer_idx" ON "todos" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "todos_property_idx" ON "todos" USING btree ("property_id");