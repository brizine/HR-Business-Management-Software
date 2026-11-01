ALTER TABLE "pto_policies" ADD COLUMN "carryover_limit_hours" double precision;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "carryover_reset" text DEFAULT 'yearly_date' NOT NULL;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "carryover_date" text DEFAULT '01-01' NOT NULL;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "grant_rules_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD COLUMN "carryover_rules_since" timestamp with time zone DEFAULT now() NOT NULL;