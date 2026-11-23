CREATE TABLE "customer_message_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"customer_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"audience" text,
	"by_id" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_message_recipients" ADD CONSTRAINT "customer_message_recipients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_message_recipients" ADD CONSTRAINT "customer_message_recipients_message_id_customer_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."customer_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_message_recipients" ADD CONSTRAINT "customer_message_recipients_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_by_id_employees_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_message_recipients_message_idx" ON "customer_message_recipients" USING btree ("message_id","status");--> statement-breakpoint
CREATE INDEX "customer_message_recipients_customer_idx" ON "customer_message_recipients" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_message_recipients_queue_idx" ON "customer_message_recipients" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "customer_messages_company_idx" ON "customer_messages" USING btree ("company_id","created_at");