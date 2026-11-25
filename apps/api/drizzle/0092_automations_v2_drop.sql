-- Automations v2. Keep the old automations to convert once the new tables exist (0093), and move
-- the old automation templates into Templates ({field} fill-ins become {{TAGS}}; email text becomes HTML).
CREATE TABLE "legacy_automations" AS SELECT * FROM "automations";--> statement-breakpoint
CREATE FUNCTION pg_temp.cd_tags(b text) RETURNS text LANGUAGE plpgsql AS $$
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
INSERT INTO "templates" ("company_id", "channel", "audience", "name", "subject", "body", "imported_from", "created_at", "updated_at")
SELECT "company_id", "kind", 'customer', "name", pg_temp.cd_tags("subject"),
  CASE WHEN "kind" = 'email' THEN '<p>' || replace(replace(replace(replace(replace(replace(pg_temp.cd_tags("body"), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\r', ''), E'\n\n', '</p><p>'), E'\n', '<br>') || '</p>'
    ELSE pg_temp.cd_tags("body") END,
  'crewdesk:' || "id", "created_at", "updated_at"
FROM "message_templates"
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "automation_runs" CASCADE;--> statement-breakpoint
DROP TABLE "automations" CASCADE;--> statement-breakpoint
DROP TABLE "message_templates" CASCADE;