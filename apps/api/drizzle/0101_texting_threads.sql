CREATE TABLE "text_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"body" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" uuid,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"customer_id" uuid,
	"employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"customer_id" uuid,
	"employee_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"unread" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_body" text DEFAULT '' NOT NULL,
	"last_direction" text DEFAULT 'out' NOT NULL,
	"last_status" text DEFAULT 'sent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting_hook_secret" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting_hook_token" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting_notify_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD COLUMN "employee_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "text_batches" ADD CONSTRAINT "text_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_batches" ADD CONSTRAINT "text_batches_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_group_members" ADD CONSTRAINT "text_group_members_group_id_text_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."text_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_group_members" ADD CONSTRAINT "text_group_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_group_members" ADD CONSTRAINT "text_group_members_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_groups" ADD CONSTRAINT "text_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "text_batches_company_idx" ON "text_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "text_group_members_customer_idx" ON "text_group_members" USING btree ("group_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "text_group_members_employee_idx" ON "text_group_members" USING btree ("group_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "text_groups_name_idx" ON "text_groups" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "text_threads_phone_idx" ON "text_threads" USING btree ("company_id","phone");--> statement-breakpoint
CREATE INDEX "text_threads_last_idx" ON "text_threads" USING btree ("company_id","last_at");--> statement-breakpoint
CREATE INDEX "text_threads_customer_idx" ON "text_threads" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_thread_id_text_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."text_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD CONSTRAINT "customer_texts_batch_id_text_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."text_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_texts_thread_idx" ON "customer_texts" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_texts_status_idx" ON "customer_texts" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_texting_hook_token_unique" UNIQUE("texting_hook_token");--> statement-breakpoint
INSERT INTO "text_threads" ("company_id", "phone", "customer_id", "last_at", "last_body", "last_direction", "last_status", "unread")
SELECT DISTINCT ON (t."company_id", t."phone") t."company_id", t."phone",
  (SELECT c."customer_id" FROM "customer_texts" c WHERE c."company_id" = t."company_id" AND c."phone" = t."phone" AND c."customer_id" IS NOT NULL ORDER BY c."created_at" DESC LIMIT 1),
  t."created_at", left(t."body", 300), t."direction", t."status",
  (SELECT count(*)::int FROM "customer_texts" u WHERE u."company_id" = t."company_id" AND u."phone" = t."phone" AND u."direction" = 'in' AND u."read_at" IS NULL)
FROM "customer_texts" t WHERE t."source" <> 'test'
ORDER BY t."company_id", t."phone", t."created_at" DESC
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "customer_texts" t SET "thread_id" = th."id" FROM "text_threads" th WHERE th."company_id" = t."company_id" AND th."phone" = t."phone" AND t."thread_id" IS NULL;
