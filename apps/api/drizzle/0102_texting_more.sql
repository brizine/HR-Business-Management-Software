CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"employee_id" uuid,
	"phone" text NOT NULL,
	"kind" text DEFAULT 'call' NOT NULL,
	"direction" text DEFAULT 'in' NOT NULL,
	"result" text DEFAULT 'answered' NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"caller_name" text,
	"transcript" text,
	"provider_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"text_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "texting_options" jsonb;--> statement-breakpoint
ALTER TABLE "customer_texts" ADD COLUMN "send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "text_quiet" jsonb;--> statement-breakpoint
ALTER TABLE "text_threads" ADD COLUMN "assigned_id" uuid;--> statement-breakpoint
ALTER TABLE "text_threads" ADD COLUMN "auto_replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_media" ADD CONSTRAINT "text_media_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_media" ADD CONSTRAINT "text_media_text_id_customer_texts_id_fk" FOREIGN KEY ("text_id") REFERENCES "public"."customer_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_quick_replies" ADD CONSTRAINT "text_quick_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_quick_replies" ADD CONSTRAINT "text_quick_replies_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_calls_customer_idx" ON "phone_calls" USING btree ("customer_id","at");--> statement-breakpoint
CREATE INDEX "phone_calls_company_idx" ON "phone_calls" USING btree ("company_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_provider_idx" ON "phone_calls" USING btree ("company_id","provider_id");--> statement-breakpoint
CREATE INDEX "text_media_text_idx" ON "text_media" USING btree ("text_id");--> statement-breakpoint
CREATE INDEX "text_quick_replies_company_idx" ON "text_quick_replies" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_assigned_id_employees_id_fk" FOREIGN KEY ("assigned_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;