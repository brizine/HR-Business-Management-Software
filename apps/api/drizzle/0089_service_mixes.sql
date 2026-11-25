CREATE TABLE "service_mixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_type_id" uuid NOT NULL,
	"mix_id" uuid NOT NULL,
	"start_date" date,
	"end_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_mixes" ADD CONSTRAINT "service_mixes_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_mixes" ADD CONSTRAINT "service_mixes_mix_id_chemical_mixes_id_fk" FOREIGN KEY ("mix_id") REFERENCES "public"."chemical_mixes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_mixes_service_idx" ON "service_mixes" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "service_mixes_mix_idx" ON "service_mixes" USING btree ("mix_id");