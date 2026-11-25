CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"audience" text DEFAULT 'customer' NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"system_key" text,
	"imported_from" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "template_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_company_idx" ON "templates" USING btree ("company_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_company_system_idx" ON "templates" USING btree ("company_id","system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_company_imported_idx" ON "templates" USING btree ("company_id","imported_from");--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_company_idx" ON "email_log" USING btree ("company_id","created_at");