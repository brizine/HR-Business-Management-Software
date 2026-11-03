ALTER TABLE "companies" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "zip" text;--> statement-breakpoint
-- Split saved one-line addresses into the boxes. "Street[, Suite], City, ST 12345" (commas or new lines)
-- splits fully; anything else goes into the street box so nothing is lost.
WITH parsed AS (
  SELECT id, regexp_match(regexp_replace(trim(address), '\s*[\r\n]+\s*', ', ', 'g'), '^(.+?),\s*(?:(.+?),\s*)?([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$') AS m
  FROM "companies" WHERE address IS NOT NULL AND trim(address) <> ''
)
UPDATE "companies" c SET
  address_line1 = CASE WHEN p.m IS NULL THEN trim(c.address) ELSE p.m[1] END,
  address_line2 = p.m[2],
  city = p.m[3],
  state = upper(p.m[4]),
  zip = p.m[5]
FROM parsed p WHERE p.id = c.id;
