CREATE TABLE "visit_weather" (
	"visit_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text,
	"observed_at" timestamp with time zone,
	"wind_mph" double precision,
	"wind_deg" integer,
	"gust_mph" double precision,
	"temp_f" double precision,
	"rain_in" double precision,
	"station" text,
	"note" text,
	"entered_by_id" uuid,
	"tries" integer DEFAULT 0 NOT NULL,
	"last_try_at" timestamp with time zone,
	"last_error" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"wind_mph" double precision NOT NULL,
	"wind_deg" integer,
	"gust_mph" double precision,
	"temp_f" double precision,
	"rain_in" double precision,
	"note" text,
	"entered_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "weather" jsonb;--> statement-breakpoint
ALTER TABLE "service_types" ADD COLUMN "chemical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "completed_lat" double precision;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "completed_lng" double precision;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "completed_accuracy" double precision;--> statement-breakpoint
ALTER TABLE "visit_weather" ADD CONSTRAINT "visit_weather_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_weather" ADD CONSTRAINT "visit_weather_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_weather" ADD CONSTRAINT "visit_weather_entered_by_id_employees_id_fk" FOREIGN KEY ("entered_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_weather" ADD CONSTRAINT "visit_weather_reviewed_by_id_employees_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_days" ADD CONSTRAINT "weather_days_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_days" ADD CONSTRAINT "weather_days_entered_by_id_employees_id_fk" FOREIGN KEY ("entered_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_weather_company_idx" ON "visit_weather" USING btree ("company_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "weather_days_company_date_idx" ON "weather_days" USING btree ("company_id","date");