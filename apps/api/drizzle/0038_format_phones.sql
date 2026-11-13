-- Show saved US phone numbers as (555) 555-5555 (international +… numbers are left alone).
--> statement-breakpoint
UPDATE "employees" SET "phone" = regexp_replace(regexp_replace("phone", '\D', '', 'g'), '^1?(\d{3})(\d{3})(\d{4})$', '(\1) \2-\3')
WHERE "phone" IS NOT NULL AND NOT ("phone" ~ '^\s*\+' AND "phone" !~ '^\s*\+1') AND regexp_replace("phone", '\D', '', 'g') ~ '^1?\d{10}$';
--> statement-breakpoint
UPDATE "employees" SET "emergency_phone" = regexp_replace(regexp_replace("emergency_phone", '\D', '', 'g'), '^1?(\d{3})(\d{3})(\d{4})$', '(\1) \2-\3')
WHERE "emergency_phone" IS NOT NULL AND NOT ("emergency_phone" ~ '^\s*\+' AND "emergency_phone" !~ '^\s*\+1') AND regexp_replace("emergency_phone", '\D', '', 'g') ~ '^1?\d{10}$';
--> statement-breakpoint
UPDATE "companies" SET "phone" = regexp_replace(regexp_replace("phone", '\D', '', 'g'), '^1?(\d{3})(\d{3})(\d{4})$', '(\1) \2-\3')
WHERE "phone" IS NOT NULL AND NOT ("phone" ~ '^\s*\+' AND "phone" !~ '^\s*\+1') AND regexp_replace("phone", '\D', '', 'g') ~ '^1?\d{10}$';
--> statement-breakpoint
UPDATE "applicants" SET "phone" = regexp_replace(regexp_replace("phone", '\D', '', 'g'), '^1?(\d{3})(\d{3})(\d{4})$', '(\1) \2-\3')
WHERE "phone" IS NOT NULL AND NOT ("phone" ~ '^\s*\+' AND "phone" !~ '^\s*\+1') AND regexp_replace("phone", '\D', '', 'g') ~ '^1?\d{10}$';
