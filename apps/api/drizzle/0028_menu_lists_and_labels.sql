ALTER TABLE "companies" ADD COLUMN "menu_lists" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "menu_labels" jsonb DEFAULT '{}'::jsonb NOT NULL;