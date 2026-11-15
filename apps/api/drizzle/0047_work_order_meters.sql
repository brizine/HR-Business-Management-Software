ALTER TABLE "work_orders" ADD COLUMN "completed_odometer" double precision;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "completed_hours" double precision;--> statement-breakpoint
UPDATE "work_orders" w SET "completed_odometer" = (
  SELECT m."odometer" FROM "meter_readings" m
  WHERE m."asset_id" = w."asset_id" AND m."odometer" IS NOT NULL AND m."odometer" > 0 AND m."created_at" <= w."completed_at" + interval '1 minute'
  ORDER BY m."created_at" DESC LIMIT 1
) WHERE w."status" = 'completed' AND w."completed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "work_orders" w SET "completed_hours" = (
  SELECT m."engine_hours" FROM "meter_readings" m
  WHERE m."asset_id" = w."asset_id" AND m."engine_hours" IS NOT NULL AND m."engine_hours" > 0 AND m."created_at" <= w."completed_at" + interval '1 minute'
  ORDER BY m."created_at" DESC LIMIT 1
) WHERE w."status" = 'completed' AND w."completed_at" IS NOT NULL;
