CREATE TABLE "invoice_layout_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"layout" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "invoice_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text DEFAULT 'Invoice layout' NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"layout" jsonb,
	"draft" jsonb,
	"draft_at" timestamp with time zone,
	"draft_by_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_layout_versions" ADD CONSTRAINT "invoice_layout_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_layout_versions" ADD CONSTRAINT "invoice_layout_versions_layout_id_invoice_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."invoice_layouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_layout_versions" ADD CONSTRAINT "invoice_layout_versions_published_by_id_employees_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_layouts" ADD CONSTRAINT "invoice_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_layouts" ADD CONSTRAINT "invoice_layouts_draft_by_id_employees_id_fk" FOREIGN KEY ("draft_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_layouts" ADD CONSTRAINT "invoice_layouts_published_by_id_employees_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_layout_versions_layout_idx" ON "invoice_layout_versions" USING btree ("layout_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_layouts_default_idx" ON "invoice_layouts" USING btree ("company_id") WHERE "invoice_layouts"."is_default";