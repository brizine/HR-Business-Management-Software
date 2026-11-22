-- A single-business install gets its test company straight away (named "<company> (Test)"), so the owner
-- doesn't have to make it. Installs with several companies, or one that already has a test company, are left alone.
INSERT INTO "companies" ("name", "timezone", "test_of_company_id", "two_factor_required_for")
SELECT c."name" || ' (Test)', c."timezone", c."id", 'none'
FROM "companies" c
WHERE c."test_of_company_id" IS NULL
  AND (SELECT count(*) FROM "companies" r WHERE r."test_of_company_id" IS NULL) = 1
  AND NOT EXISTS (SELECT 1 FROM "companies" t WHERE t."test_of_company_id" = c."id");
