ALTER TABLE "assets" ADD COLUMN "qr_code" text;--> statement-breakpoint
-- Give existing assets a code from the same unambiguous alphabet the app uses.
-- The subquery references the outer row so random() runs once per asset.
UPDATE "assets" SET "qr_code" = (
  SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '')
  FROM generate_series(1, 10) WHERE "assets"."id" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_qr_code_unique" UNIQUE("qr_code");
