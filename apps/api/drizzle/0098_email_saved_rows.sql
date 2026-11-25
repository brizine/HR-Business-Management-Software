CREATE TABLE "email_saved_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"row" jsonb NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_brand_color" text;--> statement-breakpoint
ALTER TABLE "email_saved_rows" ADD CONSTRAINT "email_saved_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_saved_rows" ADD CONSTRAINT "email_saved_rows_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_saved_rows" ADD CONSTRAINT "email_saved_rows_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_saved_rows_company_idx" ON "email_saved_rows" USING btree ("company_id");