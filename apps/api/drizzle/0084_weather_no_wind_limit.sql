ALTER TABLE "visit_weather" DROP CONSTRAINT "visit_weather_reviewed_by_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "visit_weather" DROP COLUMN "reviewed_at";--> statement-breakpoint
ALTER TABLE "visit_weather" DROP COLUMN "reviewed_by_id";--> statement-breakpoint
ALTER TABLE "visit_weather" DROP COLUMN "review_note";--> statement-breakpoint
UPDATE "companies" SET "weather" = "weather" - 'windLimitMph' WHERE "weather" ? 'windLimitMph';
