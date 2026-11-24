CREATE TABLE "service_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_type_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_rate_id" uuid NOT NULL,
	"start_date" date,
	"end_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"service_type_id" uuid,
	"product_id" uuid,
	"product_rate_id" uuid,
	"product_cost_id" uuid,
	"product_name" text NOT NULL,
	"epa_reg_no" text,
	"rate_name" text,
	"amount_per_1000" double precision NOT NULL,
	"area_sq_ft" double precision NOT NULL,
	"amount" double precision NOT NULL,
	"unit" text NOT NULL,
	"cost_per_use_unit_cents" double precision,
	"cost_cents" integer,
	"cost_date" date NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_products" ADD CONSTRAINT "service_products_product_rate_id_product_rates_id_fk" FOREIGN KEY ("product_rate_id") REFERENCES "public"."product_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_rate_id_product_rates_id_fk" FOREIGN KEY ("product_rate_id") REFERENCES "public"."product_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_product_cost_id_product_costs_id_fk" FOREIGN KEY ("product_cost_id") REFERENCES "public"."product_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_products_service_idx" ON "service_products" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "service_products_rate_idx" ON "service_products" USING btree ("product_rate_id");--> statement-breakpoint
CREATE INDEX "visit_products_visit_idx" ON "visit_products" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_products_company_product_idx" ON "visit_products" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "visit_products_cost_idx" ON "visit_products" USING btree ("product_cost_id");