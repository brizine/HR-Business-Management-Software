CREATE TABLE "portal_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"link_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_secret" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "method_detail" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pay_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_codes" ADD CONSTRAINT "portal_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_codes_email_idx" ON "portal_codes" USING btree ("company_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_codes_link_idx" ON "portal_codes" USING btree ("link_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_stripe_idx" ON "invoice_payments" USING btree ("stripe_payment_id");