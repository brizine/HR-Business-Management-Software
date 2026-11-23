ALTER TABLE "estimates" ADD COLUMN "deposit_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "deposit_kind" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "deposit_value" double precision;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "pending_response" jsonb;--> statement-breakpoint
ALTER TABLE "prepayments" ADD COLUMN "estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE set null ON UPDATE no action;