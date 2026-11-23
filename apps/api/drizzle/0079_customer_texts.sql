CREATE TABLE "customer_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"direction" text NOT NULL,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"provider_id" text,
	"source" text DEFAULT 'office' NOT NULL,
	"sent_by_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting_key" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "text_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_sent_by_id_employees_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_texts_customer_idx" ON "customer_texts" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_texts_company_idx" ON "customer_texts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_texts_phone_idx" ON "customer_texts" USING btree ("company_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_texts_provider_idx" ON "customer_texts" USING btree ("company_id","provider_id");