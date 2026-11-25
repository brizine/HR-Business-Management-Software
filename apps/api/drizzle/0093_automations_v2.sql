CREATE TABLE "automation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"customer_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"trigger_key" text NOT NULL,
	"block_index" integer,
	"dedupe_key" text NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"reason" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"customer_id" uuid,
	"kind" text DEFAULT 'action' NOT NULL,
	"idx" integer DEFAULT 0 NOT NULL,
	"action" jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'waiting' NOT NULL,
	"detail" text,
	"done_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"labels" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"review" boolean DEFAULT false NOT NULL,
	"def" jsonb NOT NULL,
	"imported_from" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "automation_off_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_reviewed_by_id_employees_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_id_employees_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_updated_by_id_employees_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_events_company_idx" ON "automation_events" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_dedupe_idx" ON "automation_runs" USING btree ("automation_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_runs_company_idx" ON "automation_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_customer_idx" ON "automation_runs" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_status_idx" ON "automation_runs" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "automation_steps_due_idx" ON "automation_steps" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "automation_steps_run_idx" ON "automation_steps" USING btree ("run_id","idx");--> statement-breakpoint
CREATE INDEX "automation_steps_company_idx" ON "automation_steps" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_company_idx" ON "automations" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_number_idx" ON "automations" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_imported_idx" ON "automations" USING btree ("company_id","imported_from");--> statement-breakpoint
CREATE FUNCTION pg_temp.cd_tags2(b text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF b IS NULL THEN RETURN NULL; END IF;
  FOR r IN SELECT * FROM (VALUES
    ('first_name','CUSTOMER_FIRST_NAME'), ('last_name','CUSTOMER_LAST_NAME'), ('name','CUSTOMER_NAME'), ('customer_number','CUSTOMER_NUMBER'),
    ('balance','CUSTOMER_ACCOUNT_BALANCE'), ('company','COMPANY_NAME'), ('company_phone','COMPANY_PHONE'), ('estimate_number','ESTIMATE_NUMBER'),
    ('estimate_title','ESTIMATE_TITLE'), ('estimate_total','ESTIMATE_TOTAL'), ('estimate_link','ESTIMATE_LINK'), ('invoice_number','INVOICE_NUMBER'),
    ('invoice_total','INVOICE_TOTAL'), ('invoice_balance','INVOICE_BALANCE'), ('invoice_due','INVOICE_DUE_DATE'), ('pay_link','INVOICES_LINKS'),
    ('visit_title','EVENT_TITLE'), ('visit_date','EVENT_DATE'), ('visit_address','EVENT_PROPERTY_ADDRESS'), ('payment_amount','PAYMENT_AMOUNT'),
    ('portal_link','CLIENT_PORTAL_LINK')
  ) AS m(f, t) LOOP
    b := regexp_replace(b, '\{\s*' || r.f || '\s*\}', '{{' || r.t || '}}', 'gi');
  END LOOP;
  RETURN b;
END $$;--> statement-breakpoint
-- The old automations, as automations (one step, nothing to stop on) or sequences. Their templates
-- are the ones moved into Templates in 0092.
WITH acts AS (
  SELECT a."id" AS aid, s.ord,
    jsonb_build_object(
      'waitMinutes', sum(coalesce((s.step->>'waitMinutes')::int, 0)) OVER (PARTITION BY a."id" ORDER BY s.ord),
      'action', CASE s.step->>'action' WHEN 'email_staff' THEN 'email_employee' WHEN 'notify_staff' THEN 'push_notification' WHEN 'create_todo' THEN 'create_assign_todo' ELSE s.step->>'action' END,
      'templateId', (SELECT t."id" FROM "templates" t WHERE t."company_id" = a."company_id" AND t."imported_from" = 'crewdesk:' || (s.step->>'templateId')),
      'employeeIds', coalesce(s.step->'employeeIds', '[]'::jsonb),
      'tagId', s.step->'tagId',
      'todoTitle', pg_temp.cd_tags2(s.step->>'todoTitle')
    ) AS act
  FROM "legacy_automations" a, jsonb_array_elements(a."steps") WITH ORDINALITY AS s(step, ord)
), agg AS (
  SELECT aid, jsonb_agg(act ORDER BY ord) AS actions, count(*) AS n, (array_agg(act ORDER BY ord))[1] AS first FROM acts GROUP BY aid
), conv AS (
  SELECT a.*, agg.actions, agg.n, agg.first,
    jsonb_build_object('key', CASE a."trigger" WHEN 'estimate_accepted' THEN 'estimate_accept' WHEN 'invoice_paid' THEN 'invoice_paid_in_full' WHEN 'payment_received' THEN 'payment_to_account'
        WHEN 'visit_added' THEN 'add_visit' WHEN 'visit_upcoming' THEN 'before_visit' WHEN 'visit_completed' THEN 'complete_visit' ELSE a."trigger" END,
      'tagIds', CASE WHEN a."tag_id" IS NOT NULL THEN jsonb_build_array(a."tag_id") ELSE '[]'::jsonb END, 'categoryIds', '[]'::jsonb, 'serviceIds', '[]'::jsonb) AS trig,
    (CASE WHEN cardinality(a."only_tag_ids") > 0 THEN jsonb_build_array(jsonb_build_object('key', 'customer_has_tag', 'tagIds', to_jsonb(a."only_tag_ids"), 'categoryIds', '[]'::jsonb, 'serviceIds', '[]'::jsonb)) ELSE '[]'::jsonb END)
      || (CASE WHEN cardinality(a."except_tag_ids") > 0 THEN jsonb_build_array(jsonb_build_object('key', 'customer_does_not_have_tag', 'tagIds', to_jsonb(a."except_tag_ids"), 'categoryIds', '[]'::jsonb, 'serviceIds', '[]'::jsonb)) ELSE '[]'::jsonb END) AS ands,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('key', m.k, 'tagIds', CASE WHEN m.k = 'tag_removed' AND a."tag_id" IS NOT NULL THEN jsonb_build_array(a."tag_id") ELSE '[]'::jsonb END, 'categoryIds', '[]'::jsonb, 'serviceIds', '[]'::jsonb)), '[]'::jsonb)
      FROM unnest(a."stop_when") sw(v)
      CROSS JOIN LATERAL unnest(CASE sw.v WHEN 'estimate_answered' THEN ARRAY['estimate_responded', 'estimate_changes'] WHEN 'invoice_paid' THEN ARRAY['invoice_paid_in_full']
        WHEN 'visit_closed' THEN ARRAY['complete_visit', 'visit_skipped'] WHEN 'tag_removed' THEN ARRAY['tag_removed'] WHEN 'customer_cancelled' THEN ARRAY['customer_inactive'] ELSE ARRAY[]::text[] END) AS m(k)) AS stops
  FROM "legacy_automations" a JOIN agg ON agg.aid = a."id"
)
INSERT INTO "automations" ("id", "company_id", "number", "kind", "name", "description", "enabled", "enabled_at", "review", "def", "imported_from", "created_by_id", "updated_at", "created_at")
SELECT c."id", c."company_id", row_number() OVER (PARTITION BY c."company_id" ORDER BY c."created_at", c."id"),
  CASE WHEN simple THEN 'simple' ELSE 'sequence' END, c."name", c."description", c."enabled", CASE WHEN c."enabled" THEN now() END, c."review",
  CASE WHEN simple THEN jsonb_build_object('kind', 'simple', 'trigger', c.trig, 'runAt', NULL,
      'delayMinutes', CASE WHEN c."trigger" = 'visit_upcoming' THEN 0 ELSE (c.first->>'waitMinutes')::int END,
      'daysBefore', CASE WHEN c."trigger" = 'visit_upcoming' THEN coalesce(c."days_before", 1) END,
      'action', c.first || '{"waitMinutes": 0}'::jsonb, 'subAction', 'none', 'subAutomationId', NULL, 'subDelayMinutes', 0)
    ELSE jsonb_build_object('kind', 'sequence', 'blocks', jsonb_build_array(jsonb_build_object('trigger', c.trig, 'or', '[]'::jsonb, 'and', c.ands, 'actions', c.actions)),
      'stops', c.stops, 'stopActions', '[]'::jsonb) END,
  'crewdesk:' || c."id", c."created_by_id", c."updated_at", c."created_at"
FROM conv c, LATERAL (SELECT c."trigger" = 'visit_upcoming' OR (c.n = 1 AND c.ands = '[]'::jsonb AND (c.stops = '[]'::jsonb OR (c.first->>'waitMinutes')::int = 0)) AS simple) k;--> statement-breakpoint
DROP TABLE "legacy_automations";
