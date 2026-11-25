ALTER TABLE "automation_steps" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "imported_on" boolean;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "password_hash" text;--> statement-breakpoint
-- Sequences now keep their conditions the way Homeworks does: groups of AND conditions, any one
-- group being enough ("when"). The old "and" list becomes one group; an old "or" trigger becomes its
-- own ELSE block with the same conditions and actions (which is what it meant).
UPDATE "automations" a SET "def" = jsonb_set(a."def", '{blocks}', (
  SELECT coalesce(jsonb_agg(x.nb ORDER BY x.ord, x.sub), '[]'::jsonb) FROM (
    SELECT b.ord, 0::bigint AS sub,
      (b.blk - 'or' - 'and') || jsonb_build_object('when', CASE WHEN jsonb_array_length(coalesce(b.blk->'and', '[]'::jsonb)) > 0 THEN jsonb_build_array(b.blk->'and') ELSE '[]'::jsonb END) AS nb
    FROM jsonb_array_elements(a."def"->'blocks') WITH ORDINALITY AS b(blk, ord)
    UNION ALL
    SELECT b.ord, o.oord,
      (b.blk - 'or' - 'and') || jsonb_build_object('trigger', o.otrig, 'when', CASE WHEN jsonb_array_length(coalesce(b.blk->'and', '[]'::jsonb)) > 0 THEN jsonb_build_array(b.blk->'and') ELSE '[]'::jsonb END)
    FROM jsonb_array_elements(a."def"->'blocks') WITH ORDINALITY AS b(blk, ord),
      jsonb_array_elements(coalesce(b.blk->'or', '[]'::jsonb)) WITH ORDINALITY AS o(otrig, oord)
  ) x
))
WHERE a."kind" = 'sequence' AND jsonb_typeof(a."def"->'blocks') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(a."def"->'blocks') b(blk) WHERE NOT (b.blk ? 'when'));--> statement-breakpoint
-- A push reminder no longer takes a template or a pick of people (it goes to whoever the work is given to).
UPDATE "automations" SET "def" = jsonb_set(jsonb_set("def", '{action,templateId}', 'null'::jsonb), '{action,employeeIds}', '[]'::jsonb)
WHERE "kind" = 'simple' AND "def"->'action'->>'action' = 'push_notification';
