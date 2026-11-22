CREATE TABLE "prepayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"description" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"covers_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"method" text,
	"method_detail" text,
	"reference" text,
	"received_on" date,
	"note" text,
	"use_now" boolean DEFAULT false NOT NULL,
	"applied_cents" integer DEFAULT 0 NOT NULL,
	"applied_discount_cents" integer DEFAULT 0 NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"discount_reversed" boolean DEFAULT false NOT NULL,
	"stripe_payment_id" text,
	"fee_cents" integer,
	"pay_token" text,
	"pay_token_expires_at" timestamp with time zone,
	"bigcapital_receipt_id" text,
	"bigcapital_refund_id" text,
	"bigcapital_refund_cents" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"closed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_credits" ADD COLUMN "prepayment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "prepayment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "bigcapital_journal_id" text;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prepayments_customer_idx" ON "prepayments" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prepayments_number_idx" ON "prepayments" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "prepayments_stripe_idx" ON "prepayments" USING btree ("stripe_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prepayments_token_idx" ON "prepayments" USING btree ("pay_token");--> statement-breakpoint
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_prepayment_id_prepayments_id_fk" FOREIGN KEY ("prepayment_id") REFERENCES "public"."prepayments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_prepayment_id_prepayments_id_fk" FOREIGN KEY ("prepayment_id") REFERENCES "public"."prepayments"("id") ON DELETE restrict ON UPDATE no action;