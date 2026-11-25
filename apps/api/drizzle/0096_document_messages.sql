ALTER TABLE "customer_messages" ADD COLUMN "format" text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD COLUMN "doc_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD COLUMN "doc_name" text;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD COLUMN "doc_content" text;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD COLUMN "attach_pdf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD COLUMN "email_template_id" uuid;