CREATE TABLE "marketing_doc_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb,
	"by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_doc_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"imported_from" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_doc_history" ADD CONSTRAINT "marketing_doc_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_doc_history" ADD CONSTRAINT "marketing_doc_history_doc_id_marketing_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."marketing_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_doc_history" ADD CONSTRAINT "marketing_doc_history_by_id_employees_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_doc_templates" ADD CONSTRAINT "marketing_doc_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_doc_templates" ADD CONSTRAINT "marketing_doc_templates_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_doc_templates" ADD CONSTRAINT "marketing_doc_templates_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_docs" ADD CONSTRAINT "marketing_docs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_docs" ADD CONSTRAINT "marketing_docs_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_docs" ADD CONSTRAINT "marketing_docs_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_doc_history_doc_idx" ON "marketing_doc_history" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE INDEX "marketing_doc_templates_company_idx" ON "marketing_doc_templates" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_doc_templates_imported_idx" ON "marketing_doc_templates" USING btree ("company_id","imported_from");--> statement-breakpoint
CREATE INDEX "marketing_docs_company_idx" ON "marketing_docs" USING btree ("company_id");