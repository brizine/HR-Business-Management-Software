CREATE TABLE "visit_form_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"action" text NOT NULL,
	"by_id" uuid,
	"changes" jsonb,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD COLUMN "signatures" jsonb;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD COLUMN "flagged" jsonb;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_form_entries" ADD COLUMN "emailed_to" text;--> statement-breakpoint
ALTER TABLE "visit_forms" ADD COLUMN "service_type_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_form_history" ADD CONSTRAINT "visit_form_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_history" ADD CONSTRAINT "visit_form_history_entry_id_visit_form_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."visit_form_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_form_history" ADD CONSTRAINT "visit_form_history_by_id_employees_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_form_history_entry_idx" ON "visit_form_history" USING btree ("entry_id","created_at");