-- Real roads and curbside arrival are on for every company from here on. An admin can still switch
-- either off under New Dispatch → View → Routing and capacity, and that choice then stays.
UPDATE "companies" SET "dispatch_settings" = coalesce("dispatch_settings", '{}'::jsonb) || '{"routing":"road","curbside":true}'::jsonb;--> statement-breakpoint
-- Routes still to be driven are planned for curbside arrival too. (Nobody had chosen against it:
-- the choice only arrived with the migration before this one.) Their drives are measured that way
-- the next time each route is ordered, optimized or opened.
-- (A day back from the server's date, so "today" is covered whatever the company's time zone.)
UPDATE "dispatch_routes" SET "curbside" = true WHERE "date" >= CURRENT_DATE - 1;
