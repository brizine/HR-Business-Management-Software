-- Adds "Truck 1.5 gal/1000" and "Backpack 1 gal/1000" for companies that already have mixes,
-- right after their Truck Mix, copying its current products and rates.
CREATE TEMP TABLE "new_mix_sheets" AS
SELECT t."company_id", t."id" AS "truck_id", t."sort_order" AS "truck_sort", n."name", n."gpa", n."tank", n."offset", gen_random_uuid() AS "id"
FROM (
  SELECT DISTINCT ON ("company_id") * FROM "mix_sheets" WHERE "name" = 'Truck Mix' ORDER BY "company_id", "sort_order", "created_at"
) t
CROSS JOIN (VALUES ('Truck 1.5 gal/1000', 65.34::double precision, 75::double precision, 1), ('Backpack 1 gal/1000', 43.56, 4, 2)) AS n("name", "gpa", "tank", "offset")
WHERE NOT EXISTS (SELECT 1 FROM "mix_sheets" x WHERE x."company_id" = t."company_id" AND x."name" = n."name");
--> statement-breakpoint
UPDATE "mix_sheets" s SET "sort_order" = s."sort_order" + 2
FROM (SELECT DISTINCT "company_id", "truck_sort" FROM "new_mix_sheets") t
WHERE s."company_id" = t."company_id" AND s."sort_order" > t."truck_sort";
--> statement-breakpoint
INSERT INTO "mix_sheets" ("id", "company_id", "name", "gallons_per_acre", "default_tank_gallons", "sort_order")
SELECT "id", "company_id", "name", "gpa", "tank", "truck_sort" + "offset" FROM "new_mix_sheets";
--> statement-breakpoint
INSERT INTO "mix_products" ("sheet_id", "name", "rate_per_acre", "unit", "sort_order")
SELECT n."id", p."name", p."rate_per_acre", p."unit", p."sort_order"
FROM "new_mix_sheets" n JOIN "mix_products" p ON p."sheet_id" = n."truck_id";
--> statement-breakpoint
INSERT INTO "mix_changes" ("company_id", "sheet_id", "summary")
SELECT "company_id", "id", "name" || ': added with the Truck Mix products' FROM "new_mix_sheets";
--> statement-breakpoint
DROP TABLE "new_mix_sheets";
