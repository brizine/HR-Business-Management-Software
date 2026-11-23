CREATE TABLE "customer_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"stripe_payment_method_id" text NOT NULL,
	"type" text NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"bank_name" text,
	"account_type" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"added_by" text DEFAULT 'customer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "autopay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "autopay_error" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "autopay_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_payment_methods" ADD CONSTRAINT "customer_payment_methods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_methods" ADD CONSTRAINT "customer_payment_methods_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_methods_stripe_idx" ON "customer_payment_methods" USING btree ("stripe_payment_method_id");--> statement-breakpoint
CREATE INDEX "customer_payment_methods_customer_idx" ON "customer_payment_methods" USING btree ("customer_id");