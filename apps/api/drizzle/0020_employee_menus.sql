ALTER TABLE "companies" ADD COLUMN "job_titles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "departments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Start each company's menus from the job titles and departments already in use.
UPDATE "companies" c SET
  "job_titles" = COALESCE((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT trim("title") AS t FROM "employees" WHERE "company_id" = c."id" AND trim(coalesce("title", '')) <> '') x), '[]'::jsonb),
  "departments" = COALESCE((SELECT jsonb_agg(d ORDER BY d) FROM (
    SELECT trim("department") AS d FROM "employees" WHERE "company_id" = c."id" AND trim(coalesce("department", '')) <> ''
    UNION SELECT trim("department") FROM "jobs" WHERE "company_id" = c."id" AND trim(coalesce("department", '')) <> '') y), '[]'::jsonb);
