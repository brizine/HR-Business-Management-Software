ALTER TABLE "customers" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_exempt_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_rate" double precision;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rate" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "tax_rate" double precision;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_lines" ADD COLUMN "tax_rate" double precision DEFAULT 0 NOT NULL;