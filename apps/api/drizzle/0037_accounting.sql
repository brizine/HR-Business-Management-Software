CREATE TABLE "accounting_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"external_id" text,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"error" text,
	"posted_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "accounting" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "accounting_key" text;--> statement-breakpoint
ALTER TABLE "accounting_postings" ADD CONSTRAINT "accounting_postings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_postings" ADD CONSTRAINT "accounting_postings_posted_by_id_employees_id_fk" FOREIGN KEY ("posted_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_postings_source_idx" ON "accounting_postings" USING btree ("company_id","kind","source_id");