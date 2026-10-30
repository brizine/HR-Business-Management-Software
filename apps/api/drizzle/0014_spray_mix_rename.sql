-- Renames the starter mixes, unless the company already has a mix with the new name.
CREATE TEMP TABLE "mix_renames" AS
SELECT s."id", s."company_id", s."name" AS "old_name", n."new_name"
FROM "mix_sheets" s
JOIN (VALUES ('Truck Mix', 'Truck 2gal/1000ft'), ('Truck 1.5 gal/1000', 'Truck 1.5gal/1000ft'),
             ('Backpack 1 gal/1000', 'Backpack 1gal/1000ft'), ('Z spray Mix', 'ZSpray(Green Tips)')) AS n("old_name", "new_name")
  ON s."name" = n."old_name"
WHERE NOT EXISTS (SELECT 1 FROM "mix_sheets" x WHERE x."company_id" = s."company_id" AND x."name" = n."new_name");
--> statement-breakpoint
UPDATE "mix_sheets" s SET "name" = r."new_name" FROM "mix_renames" r WHERE s."id" = r."id";
--> statement-breakpoint
INSERT INTO "mix_changes" ("company_id", "sheet_id", "summary")
SELECT "company_id", "id", "old_name" || ': renamed to "' || "new_name" || '"' FROM "mix_renames";
--> statement-breakpoint
DROP TABLE "mix_renames";
