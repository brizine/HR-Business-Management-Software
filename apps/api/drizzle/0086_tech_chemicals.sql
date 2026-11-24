ALTER TABLE "application_record_products" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "mix_products" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "mix_sheet_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "visit_products" ADD COLUMN "carrier_gal_per_1000" double precision;--> statement-breakpoint
ALTER TABLE "mix_products" ADD CONSTRAINT "mix_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_products" ADD CONSTRAINT "visit_products_mix_sheet_id_mix_sheets_id_fk" FOREIGN KEY ("mix_sheet_id") REFERENCES "public"."mix_sheets"("id") ON DELETE set null ON UPDATE no action;