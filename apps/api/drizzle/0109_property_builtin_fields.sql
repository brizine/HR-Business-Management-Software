ALTER TABLE "custom_fields" ADD COLUMN "builtin" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "other_sq_ft" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_builtin_key" ON "custom_fields" USING btree ("company_id","applies_to","builtin") WHERE "custom_fields"."builtin" is not null;