ALTER TABLE "employees" ADD COLUMN "calendar_token" text;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_calendar_token_unique" UNIQUE("calendar_token");