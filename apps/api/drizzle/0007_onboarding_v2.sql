ALTER TABLE "employees" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD COLUMN "action" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "password_resets" ADD COLUMN "purpose" text DEFAULT 'reset' NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Tasks and templates created before task actions existed: "needs document" becomes an upload task.
UPDATE "onboarding_tasks" SET "action" = 'upload' WHERE "requires_document" = true;--> statement-breakpoint
UPDATE "onboarding_templates" SET "tasks" = (
  SELECT jsonb_agg(t || jsonb_build_object('action', CASE WHEN (t->>'requiresDocument')::boolean THEN 'upload' ELSE 'none' END))
  FROM jsonb_array_elements("tasks") AS t
) WHERE NOT ("tasks"->0 ? 'action');
