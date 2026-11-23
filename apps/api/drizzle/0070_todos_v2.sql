CREATE TABLE "off_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_md" text NOT NULL,
	"end_md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"caption" text,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"rule" jsonb NOT NULL,
	"start_date" date NOT NULL,
	"shift_days" integer DEFAULT 0 NOT NULL,
	"off_season_id" uuid,
	"generated_through" date NOT NULL,
	"stopped_at" timestamp with time zone,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "tracked_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "off_seasons" ADD CONSTRAINT "off_seasons_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_categories" ADD CONSTRAINT "todo_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_files" ADD CONSTRAINT "todo_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_files" ADD CONSTRAINT "todo_files_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_files" ADD CONSTRAINT "todo_files_uploaded_by_id_employees_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_notes" ADD CONSTRAINT "todo_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_notes" ADD CONSTRAINT "todo_notes_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_notes" ADD CONSTRAINT "todo_notes_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_series" ADD CONSTRAINT "todo_series_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_series" ADD CONSTRAINT "todo_series_off_season_id_off_seasons_id_fk" FOREIGN KEY ("off_season_id") REFERENCES "public"."off_seasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "off_seasons_company_name_idx" ON "off_seasons" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "todo_categories_company_name_idx" ON "todo_categories" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "todo_files_todo_idx" ON "todo_files" USING btree ("todo_id");--> statement-breakpoint
CREATE INDEX "todo_notes_todo_idx" ON "todo_notes" USING btree ("todo_id");--> statement-breakpoint
CREATE INDEX "todo_series_company_idx" ON "todo_series" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_category_id_todo_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."todo_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE set null ON UPDATE no action;