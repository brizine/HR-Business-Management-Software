ALTER TABLE "invoice_payments" ADD COLUMN "bigcapital_credit_note_id" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "bigcapital_application_id" text;--> statement-breakpoint
ALTER TABLE "prepayments" ADD COLUMN "income" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prepayments" ADD COLUMN "bigcapital_as_income" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "prepayments" SET "income" = jsonb_build_array(jsonb_build_object('code', '4000', 'cents', "amount_cents")) WHERE "income" = '[]'::jsonb;
