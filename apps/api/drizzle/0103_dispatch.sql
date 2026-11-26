CREATE TABLE "dispatch_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"crew_id" uuid,
	"start_kind" text DEFAULT 'company' NOT NULL,
	"start_label" text,
	"start_lat" double precision,
	"start_lng" double precision,
	"end_kind" text DEFAULT 'company' NOT NULL,
	"end_label" text,
	"end_lat" double precision,
	"end_lng" double precision,
	"start_time" text DEFAULT '08:00' NOT NULL,
	"pinned_first" boolean DEFAULT false NOT NULL,
	"total_meters" double precision,
	"total_drive_seconds" integer,
	"end_meters" double precision,
	"end_seconds" integer,
	"measured" text,
	"geometry" jsonb,
	"created_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"visit_id" uuid,
	"todo_id" uuid,
	"stop_order" integer NOT NULL,
	"drive_seconds" integer,
	"drive_meters" double precision
);
--> statement-breakpoint
CREATE TABLE "map_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#2563eb' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"points" jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_dispatch_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "dispatch_settings" jsonb;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "daily_capacity_hours" double precision DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "weekly_capacity_hours" double precision;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "capacity_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_routes" ADD CONSTRAINT "dispatch_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_routes" ADD CONSTRAINT "dispatch_routes_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_routes" ADD CONSTRAINT "dispatch_routes_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_stops" ADD CONSTRAINT "dispatch_stops_route_id_dispatch_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."dispatch_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_stops" ADD CONSTRAINT "dispatch_stops_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_stops" ADD CONSTRAINT "dispatch_stops_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_areas" ADD CONSTRAINT "map_areas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_areas" ADD CONSTRAINT "map_areas_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_dispatch_notes" ADD CONSTRAINT "visit_dispatch_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_dispatch_notes" ADD CONSTRAINT "visit_dispatch_notes_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_dispatch_notes" ADD CONSTRAINT "visit_dispatch_notes_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_routes_company_date_idx" ON "dispatch_routes" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "dispatch_stops_route_idx" ON "dispatch_stops" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_stops_visit_idx" ON "dispatch_stops" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_stops_todo_idx" ON "dispatch_stops" USING btree ("todo_id");--> statement-breakpoint
CREATE INDEX "map_areas_company_idx" ON "map_areas" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "visit_dispatch_notes_visit_idx" ON "visit_dispatch_notes" USING btree ("visit_id");