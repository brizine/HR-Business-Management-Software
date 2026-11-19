CREATE TABLE "address_counties" (
	"county" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"loaded_at" timestamp with time zone,
	"status" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "address_points" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "address_points_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"county" text NOT NULL,
	"key" text NOT NULL,
	"full_address" text NOT NULL,
	"city" text,
	"zip" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX "address_points_key_idx" ON "address_points" USING btree ("key" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "address_points_county_idx" ON "address_points" USING btree ("county");