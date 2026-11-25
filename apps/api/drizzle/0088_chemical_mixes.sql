CREATE TABLE "chemical_mix_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mix_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"rate_per_1000" double precision NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chemical_mixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"application_method_id" uuid,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_record_products" ADD COLUMN "mix_name" text;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "mix_name" text;--> statement-breakpoint
ALTER TABLE "chemical_mix_items" ADD CONSTRAINT "chemical_mix_items_mix_id_chemical_mixes_id_fk" FOREIGN KEY ("mix_id") REFERENCES "public"."chemical_mixes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_mix_items" ADD CONSTRAINT "chemical_mix_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_mixes" ADD CONSTRAINT "chemical_mixes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_mixes" ADD CONSTRAINT "chemical_mixes_application_method_id_application_methods_id_fk" FOREIGN KEY ("application_method_id") REFERENCES "public"."application_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chemical_mixes" ADD CONSTRAINT "chemical_mixes_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chemical_mix_items_mix_idx" ON "chemical_mix_items" USING btree ("mix_id");--> statement-breakpoint
CREATE INDEX "chemical_mixes_company_idx" ON "chemical_mixes" USING btree ("company_id","sort_order");