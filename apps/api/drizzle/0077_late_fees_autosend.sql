CREATE TABLE "invoice_late_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"line_id" uuid,
	"waived_at" timestamp with time zone,
	"waived_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "late_fee_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "late_fee_rules" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "auto_send_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "auto_send_schedule" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "is_late_fee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "late_fee_rules" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sent_on" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "auto_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_late_fees" ADD CONSTRAINT "invoice_late_fees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_late_fees" ADD CONSTRAINT "invoice_late_fees_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_late_fees" ADD CONSTRAINT "invoice_late_fees_line_id_invoice_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_late_fees" ADD CONSTRAINT "invoice_late_fees_waived_by_id_employees_id_fk" FOREIGN KEY ("waived_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_late_fees_step_idx" ON "invoice_late_fees" USING btree ("invoice_id","days");