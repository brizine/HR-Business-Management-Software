import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, type SQL } from "drizzle-orm";
import { WEEKDAYS, availabilityConflicts, describeRule, isInactive, shiftBaseSchema, shiftRangeSchema, shiftSchema, shiftSegments, shiftTemplateSchema, type ShiftInput } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { assets, availability, companies, employees, ptoRequests, shiftTemplates, shifts } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { approversFor, except, notify, staffWithRole } from "../lib/notify";
import { addDaysYmd, fmtDayMdy, fmtShift, fmtTime, localDate, localParts, zonedTime } from "../lib/tz";

/** Which area of the Permissions page controls access here. */
const AREA = "schedule" as const;

type ShiftRow = typeof shifts.$inferSelect;
const WEEK_MS = 7 * 86_400_000;

async function companyTz(companyId: string) {
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  return c.tz;
}

async function loadShift(companyId: string, id: string) {
  const [row] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.id, id), eq(shifts.companyId, companyId)));
  if (!row) notFound("Shift");
  return row;
}

/** Throws 409 if the employee already has a shift overlapping [start, end). */
async function assertNoOverlap(employeeId: string, start: Date, end: Date, ignoreId?: string, ignoreAlso?: Set<string>) {
  const filters: SQL[] = [eq(shifts.employeeId, employeeId), lt(shifts.startsAt, end), gt(shifts.endsAt, start)];
  if (ignoreId) filters.push(ne(shifts.id, ignoreId));
  if (ignoreAlso?.size) filters.push(notInArray(shifts.id, [...ignoreAlso]));
  const [clash] = await db
    .select()
    .from(shifts)
    .where(and(...filters))
    .limit(1);
  if (clash) {
    // Say which shift, so it can be found (it may be a draft, or start the day before).
    const tz = await companyTz(clash.companyId);
    const when = `${fmtDayMdy(clash.startsAt, tz)}, ${fmtTime(clash.startsAt, tz)} – ${fmtTime(clash.endsAt, tz)}`;
    throw new HttpError(409, `This person already has a shift that overlaps that time: ${when}${clash.status === "draft" ? " (draft)" : ""}`);
  }
}

/** Validates references and returns non-blocking warnings (e.g. approved time off that day). */
async function check(companyId: string, s: ShiftInput, ignoreId?: string, ignoreAlso?: Set<string>) {
  const warnings: string[] = [];
  if (s.assetId) {
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, s.assetId), eq(assets.companyId, companyId)));
    if (!a) notFound("Asset");
    if (a.status === "out_of_service" || a.status === "in_shop") warnings.push(`${a.name} is currently ${a.status.replace(/_/g, " ")}`);
  }
  if (!s.employeeId) return warnings;

  const [emp] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, s.employeeId), eq(employees.companyId, companyId)));
  if (!emp) notFound("Employee");
  if (isInactive(emp.status)) throw new HttpError(400, `${emp.firstName} ${emp.lastName} is ${emp.status}`);

  const start = new Date(s.startsAt);
  const end = new Date(s.endsAt);
  await assertNoOverlap(emp.id, start, end, ignoreId, ignoreAlso);

  const tz = await companyTz(companyId);
  const [pto] = await db
    .select()
    .from(ptoRequests)
    .where(
      and(
        eq(ptoRequests.employeeId, emp.id),
        eq(ptoRequests.status, "approved"),
        lte(ptoRequests.startDate, localDate(end, tz)),
        gte(ptoRequests.endDate, localDate(start, tz)),
      ),
    )
    .limit(1);
  if (pto) warnings.push(`${emp.firstName} has approved time off ${pto.startDate} to ${pto.endDate}`);

  const rules = await db.select().from(availability).where(eq(availability.employeeId, emp.id));
  for (const r of availabilityConflicts(rules, shiftSegments(localParts(start, tz), localParts(end, tz)))) {
    warnings.push(`${emp.firstName} can't work ${WEEKDAYS[r.weekday]}s ${describeRule(r).toLowerCase()}${r.note ? ` (${r.note})` : ""}`);
  }
  return warnings;
}

function toRow(s: ShiftInput) {
  return {
    employeeId: s.employeeId ?? null,
    startsAt: new Date(s.startsAt),
    endsAt: new Date(s.endsAt),
    position: s.position ?? null,
    location: s.location ?? null,
    assetId: s.assetId ?? null,
    notes: s.notes ?? null,
  };
}

const fmtHm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function toInput(r: ShiftRow): ShiftInput {
  return {
    employeeId: r.employeeId,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    position: r.position ?? undefined,
    location: r.location ?? undefined,
    assetId: r.assetId,
    notes: r.notes ?? undefined,
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /**
   * Shifts starting in [from, to). Everyone sees the published team schedule;
   * only managers see drafts.
   */
  app.get("/", async (req) => {
    const q = parse(shiftRangeSchema.extend({ employeeId: z.string().uuid().optional() }), req.query);
    const filters: SQL[] = [
      eq(shifts.companyId, req.user.companyId),
      gte(shifts.startsAt, new Date(q.from)),
      lt(shifts.startsAt, new Date(q.to)),
    ];
    if (q.employeeId) filters.push(eq(shifts.employeeId, q.employeeId));
    if (!isManager(req, AREA)) filters.push(eq(shifts.status, "published"));
    return db
      .select({
        shift: shifts,
        employee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName },
        assetName: assets.name,
      })
      .from(shifts)
      .leftJoin(employees, eq(employees.id, shifts.employeeId))
      .leftJoin(assets, eq(assets.id, shifts.assetId))
      .where(and(...filters))
      .orderBy(asc(shifts.startsAt));
  });

  /** The signed-in employee's upcoming published shifts, plus open shifts they could pick up. */
  app.get("/mine", async (req) => {
    const now = new Date();
    const until = new Date(now.getTime() + 2 * WEEK_MS);
    const base = and(
      eq(shifts.companyId, req.user.companyId),
      eq(shifts.status, "published"),
      gt(shifts.endsAt, now),
      lt(shifts.startsAt, until),
    );
    const select = { shift: shifts, assetName: assets.name };
    const [mine, open] = await Promise.all([
      db.select(select).from(shifts).leftJoin(assets, eq(assets.id, shifts.assetId))
        .where(and(base, eq(shifts.employeeId, req.user.sub))).orderBy(asc(shifts.startsAt)),
      db.select(select).from(shifts).leftJoin(assets, eq(assets.id, shifts.assetId))
        .where(and(base, isNull(shifts.employeeId), gt(shifts.startsAt, now))).orderBy(asc(shifts.startsAt)),
    ]);
    return { mine, open };
  });

  // ---- Templates ----

  app.get("/templates", { preHandler: requireRole("manager", AREA) }, async (req) =>
    db.select().from(shiftTemplates).where(eq(shiftTemplates.companyId, req.user.companyId)).orderBy(asc(shiftTemplates.startTime)),
  );

  async function checkTemplateAsset(companyId: string, assetId?: string | null) {
    if (!assetId) return;
    const [a] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)));
    if (!a) notFound("Asset");
  }

  app.post("/templates", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(shiftTemplateSchema, req.body);
    await checkTemplateAsset(req.user.companyId, body.assetId);
    const [row] = await db.insert(shiftTemplates).values({ ...body, companyId: req.user.companyId }).returning();
    return row;
  });

  app.patch<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(shiftTemplateSchema.partial(), req.body);
    await checkTemplateAsset(req.user.companyId, body.assetId);
    const [row] = await db
      .update(shiftTemplates)
      .set(body)
      .where(and(eq(shiftTemplates.id, req.params.id), eq(shiftTemplates.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Template");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const [row] = await db
      .delete(shiftTemplates)
      .where(and(eq(shiftTemplates.id, req.params.id), eq(shiftTemplates.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Template");
    return { ok: true };
  });

  /** Shifts whose employee asked to give them up, awaiting a manager. */
  app.get("/drop-requests", { preHandler: requireRole("manager", AREA) }, async (req) =>
    db
      .select({ shift: shifts, employee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName } })
      .from(shifts)
      .innerJoin(employees, eq(employees.id, shifts.employeeId))
      .where(and(eq(shifts.companyId, req.user.companyId), isNotNull(shifts.dropRequestedAt)))
      .orderBy(asc(shifts.startsAt)),
  );

  app.post("/", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(shiftSchema, req.body);
    const warnings = await check(req.user.companyId, body);
    const [shift] = await db
      .insert(shifts)
      .values({ ...toRow(body), companyId: req.user.companyId })
      .returning();
    return { shift, warnings };
  });

  /**
   * Adds several shifts at once (e.g. the same hours on each day of a week). All are checked first;
   * if any can't be added (overlap, inactive person…) nothing is saved and the error names the day.
   * With skipOverlaps (repeating over weeks), days that would double-book someone are left out instead.
   */
  app.post("/bulk", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { shifts: list, skipOverlaps } = parse(z.object({
      shifts: z.array(shiftSchema).min(1).max(100),
      /** For repeating over weeks: leave out days the person already has a shift, instead of failing. */
      skipOverlaps: z.boolean().optional(),
    }), req.body);
    const tz = await companyTz(req.user.companyId);
    const day = (s: ShiftInput) => fmtDayMdy(new Date(s.startsAt), tz);
    const sorted = [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    for (let i = 1; i < sorted.length; i++) {
      const [a, b] = [sorted[i - 1], sorted[i]];
      if ((a.employeeId ?? null) === (b.employeeId ?? null) && a.employeeId && Date.parse(b.startsAt) < Date.parse(a.endsAt)) {
        throw new HttpError(409, `The shifts on ${day(a)} and ${day(b)} overlap`);
      }
    }
    const warnings = new Set<string>();
    const keep: ShiftInput[] = [];
    const skipped: string[] = [];
    for (const s of sorted) {
      try {
        for (const w of await check(req.user.companyId, s)) warnings.add(w);
        keep.push(s);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 409 && skipOverlaps) { skipped.push(day(s)); continue; }
        if (e instanceof HttpError) throw new HttpError(e.statusCode, `${day(s)}: ${e.message}`);
        throw e;
      }
    }
    const rows = keep.length ? await db.insert(shifts).values(keep.map((s) => ({ ...toRow(s), companyId: req.user.companyId }))).returning() : [];
    return { shifts: rows, skipped, warnings: [...warnings] };
  });

  /**
   * Changes or deletes every shift in a date range at once (a week, a month…), optionally only one
   * person's, open shifts, drafts or published ones. "preview" just counts them. Changes are all or
   * nothing: if any shift can't be changed (e.g. it would double-book someone) nothing is saved.
   */
  app.post("/range", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const ymdField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
    const body = parse(z.object({
      from: ymdField,
      to: ymdField,
      /** Whose shifts: everyone (default), "open" for open shifts, or one person's id. */
      who: z.union([z.literal("all"), z.literal("open"), z.string().uuid()]).default("all"),
      status: z.enum(["draft", "published"]).optional(),
      action: z.enum(["preview", "delete", "update"]),
      /** Only what's given changes. employeeId null makes them open shifts; assetId null removes the vehicle. */
      changes: z.object({
        startTime: hhmm.optional(),
        endTime: hhmm.optional(),
        employeeId: z.string().uuid().nullable().optional(),
        position: z.string().trim().max(120).optional(),
        location: z.string().trim().max(200).optional(),
        assetId: z.string().uuid().nullable().optional(),
        notes: z.string().trim().max(500).optional(),
      }).default({}),
    }), req.body);
    if (body.to < body.from) throw new HttpError(400, "The end date is before the start date");
    const tz = await companyTz(req.user.companyId);
    const filters: SQL[] = [
      eq(shifts.companyId, req.user.companyId),
      gte(shifts.startsAt, zonedTime(body.from, "00:00", tz)),
      lt(shifts.startsAt, zonedTime(addDaysYmd(body.to, 1), "00:00", tz)),
    ];
    if (body.who === "open") filters.push(isNull(shifts.employeeId));
    else if (body.who !== "all") filters.push(eq(shifts.employeeId, body.who));
    if (body.status) filters.push(eq(shifts.status, body.status));
    const found = await db.select().from(shifts).where(and(...filters)).orderBy(asc(shifts.startsAt));
    const published = found.filter((s) => s.status === "published");

    if (body.action === "preview") return { count: found.length, published: published.length };
    if (!found.length) throw new HttpError(400, "No shifts match");

    /** Tells each affected person once, e.g. "3 of your shifts were changed". */
    const tell = (ids: (string | null)[], title: (n: number) => string) => {
      const counts = new Map<string, number>();
      for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of counts) {
        notify(req.user.companyId, except([id], req.user.sub), {
          category: "schedule", title: title(n), body: `Between ${fmtDayMdy(zonedTime(body.from, "12:00", tz), tz)} and ${fmtDayMdy(zonedTime(body.to, "12:00", tz), tz)}`, link: { screen: "schedule" },
        });
      }
    };

    if (body.action === "delete") {
      await db.delete(shifts).where(inArray(shifts.id, found.map((s) => s.id)));
      tell(published.map((s) => s.employeeId), (n) => (n === 1 ? "A shift was removed from your schedule" : `${n} shifts were removed from your schedule`));
      return { deleted: found.length };
    }

    const c = body.changes;
    if (!Object.values(c).some((v) => v !== undefined)) throw new HttpError(400, "Choose something to change");
    const updated = found.map((s) => {
      const input = toInput(s);
      if (c.startTime || c.endTime) {
        const day = localParts(s.startsAt, tz).date;
        const startT = c.startTime ?? fmtHm(localParts(s.startsAt, tz).minutes);
        const endT = c.endTime ?? fmtHm(localParts(s.endsAt, tz).minutes);
        const start = zonedTime(day, startT, tz);
        let end = zonedTime(day, endT, tz);
        // An end time at or before the start runs past midnight.
        if (end <= start) end = zonedTime(addDaysYmd(day, 1), endT, tz);
        input.startsAt = start.toISOString();
        input.endsAt = end.toISOString();
      }
      if (c.employeeId !== undefined) input.employeeId = c.employeeId;
      if (c.position !== undefined) input.position = c.position || undefined;
      if (c.location !== undefined) input.location = c.location || undefined;
      if (c.assetId !== undefined) input.assetId = c.assetId;
      if (c.notes !== undefined) input.notes = c.notes || undefined;
      return { before: s, input };
    });
    const day = (s: ShiftInput) => fmtDayMdy(new Date(s.startsAt), tz);
    // The changed shifts mustn't overlap each other for the same person…
    const byStart = [...updated].sort((a, b) => Date.parse(a.input.startsAt) - Date.parse(b.input.startsAt));
    for (let i = 1; i < byStart.length; i++) {
      const [a, b] = [byStart[i - 1].input, byStart[i].input];
      if (a.employeeId && a.employeeId === b.employeeId && Date.parse(b.startsAt) < Date.parse(a.endsAt)) {
        throw new HttpError(409, `The shifts on ${day(a)} and ${day(b)} would overlap`);
      }
    }
    // …or anyone's other shifts. Shifts being changed are compared by their new times only.
    const changing = new Set(found.map((s) => s.id));
    const warnings = new Set<string>();
    for (const u of updated) {
      const parsed = shiftSchema.safeParse(u.input);
      if (!parsed.success) throw new HttpError(400, `${day(u.input)}: ${parsed.error.issues[0].message}`);
      try {
        for (const w of await check(req.user.companyId, parsed.data, u.before.id, changing)) warnings.add(w);
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.statusCode, `${day(u.input)}: ${e.message}`);
        throw e;
      }
    }
    await db.transaction(async (tx) => {
      for (const u of updated) {
        const reassigned = (u.input.employeeId ?? null) !== u.before.employeeId;
        await tx.update(shifts).set({ ...toRow(u.input), ...(reassigned ? { dropRequestedAt: null, dropReason: null } : {}) }).where(eq(shifts.id, u.before.id));
      }
    });
    const pub = updated.filter((u) => u.before.status === "published");
    const moved = pub.filter((u) => (u.input.employeeId ?? null) !== u.before.employeeId);
    tell(pub.filter((u) => !moved.includes(u)).map((u) => u.before.employeeId), (n) => (n === 1 ? "Your shift was changed" : `${n} of your shifts were changed`));
    tell(moved.map((u) => u.before.employeeId), (n) => (n === 1 ? "You were taken off a shift" : `You were taken off ${n} shifts`));
    tell(moved.map((u) => u.input.employeeId ?? null), (n) => (n === 1 ? "New shift added to your schedule" : `${n} shifts were added to your schedule`));
    return { updated: updated.length, warnings: [...warnings] };
  });

  /** Edits a shift. Changes to a published shift are announced to whoever it affects. */
  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const existing = await loadShift(req.user.companyId, req.params.id);
    const merged = parse(shiftSchema, { ...toInput(existing), ...parse(shiftBaseSchema.partial(), req.body) });
    const warnings = await check(req.user.companyId, merged, existing.id);
    const reassigned = (merged.employeeId ?? null) !== existing.employeeId;
    const [shift] = await db
      .update(shifts)
      .set({ ...toRow(merged), ...(reassigned ? { dropRequestedAt: null, dropReason: null } : {}) })
      .where(eq(shifts.id, existing.id))
      .returning();

    if (existing.status === "published") {
      const tz = await companyTz(req.user.companyId);
      const when = fmtShift(shift.startsAt, shift.endsAt, tz);
      if (reassigned) {
        notify(req.user.companyId, except([existing.employeeId], req.user.sub), {
          category: "schedule",
          title: "You were taken off a shift",
          body: fmtShift(existing.startsAt, existing.endsAt, tz),
          link: { screen: "schedule" },
        });
        notify(req.user.companyId, except([shift.employeeId], req.user.sub), {
          category: "schedule", title: "New shift added to your schedule", body: when, link: { screen: "schedule" },
        });
      } else {
        notify(req.user.companyId, except([shift.employeeId], req.user.sub), {
          category: "schedule", title: "Your shift was changed", body: when, link: { screen: "schedule" },
        });
      }
    }
    return { shift, warnings };
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const existing = await loadShift(req.user.companyId, req.params.id);
    await db.delete(shifts).where(eq(shifts.id, existing.id));
    if (existing.status === "published") {
      notify(req.user.companyId, except([existing.employeeId], req.user.sub), {
        category: "schedule",
        title: "A shift was removed from your schedule",
        body: fmtShift(existing.startsAt, existing.endsAt, await companyTz(req.user.companyId)),
        link: { screen: "schedule" },
      });
    }
    return { ok: true };
  });

  /** Publishes every draft in the range and tells each scheduled person once. */
  app.post("/publish", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { from, to } = parse(shiftRangeSchema, req.body);
    const published = await db
      .update(shifts)
      .set({ status: "published" })
      .where(
        and(
          eq(shifts.companyId, req.user.companyId),
          eq(shifts.status, "draft"),
          gte(shifts.startsAt, new Date(from)),
          lt(shifts.startsAt, new Date(to)),
        ),
      )
      .returning();
    if (!published.length) return { published: 0 };

    const tz = await companyTz(req.user.companyId);
    // `from` is midnight in the manager's browser zone; reading it at midday keeps the label
    // on the right calendar day even if that zone differs from the company's by up to 12 hours.
    const weekOf = new Date(Date.parse(from) + 12 * 3_600_000).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
    const byEmployee = new Map<string, number>();
    for (const s of published) if (s.employeeId) byEmployee.set(s.employeeId, (byEmployee.get(s.employeeId) ?? 0) + 1);
    for (const [employeeId, n] of byEmployee) {
      notify(req.user.companyId, except([employeeId], req.user.sub), {
        category: "schedule",
        title: `Your schedule for the week of ${weekOf} is posted`,
        body: `You have ${n} new shift${n > 1 ? "s" : ""}.`,
        link: { screen: "schedule" },
      });
    }
    const open = published.filter((s) => !s.employeeId).length;
    if (open) await announceOpenShifts(req, open);
    return { published: published.length };
  });

  /**
   * Copies the shifts in [from, to) forward one week as drafts, skipping any
   * that would overlap something already scheduled.
   */
  app.post("/copy-week", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { from, to } = parse(shiftRangeSchema, req.body);
    const source = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.companyId, req.user.companyId), gte(shifts.startsAt, new Date(from)), lt(shifts.startsAt, new Date(to))));
    let copied = 0;
    let skipped = 0;
    for (const s of source) {
      // Fixed 7×24h offset: a shift copied across a daylight-saving change moves by an hour.
      const startsAt = new Date(s.startsAt.getTime() + WEEK_MS);
      const endsAt = new Date(s.endsAt.getTime() + WEEK_MS);
      if (s.employeeId) {
        try {
          await assertNoOverlap(s.employeeId, startsAt, endsAt);
        } catch {
          skipped++;
          continue;
        }
      }
      await db.insert(shifts).values({
        companyId: s.companyId,
        employeeId: s.employeeId,
        startsAt,
        endsAt,
        position: s.position,
        location: s.location,
        assetId: s.assetId,
        notes: s.notes,
      });
      copied++;
    }
    return { copied, skipped };
  });

  /** An employee picks up an open published shift. */
  app.post<{ Params: { id: string } }>("/:id/claim", async (req) => {
    const shift = await loadShift(req.user.companyId, req.params.id);
    if (shift.status !== "published" || shift.employeeId) throw new HttpError(409, "This shift is no longer open");
    if (shift.startsAt <= new Date()) throw new HttpError(409, "This shift has already started");
    await assertNoOverlap(req.user.sub, shift.startsAt, shift.endsAt);
    // Conditional update so two people claiming at once can't both win.
    const [claimed] = await db
      .update(shifts)
      .set({ employeeId: req.user.sub })
      .where(and(eq(shifts.id, shift.id), isNull(shifts.employeeId)))
      .returning();
    if (!claimed) throw new HttpError(409, "Someone else just picked up this shift");

    const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    notify(req.user.companyId, except(await approversFor(req.user.companyId, req.user.sub, AREA), req.user.sub), {
      category: "schedule",
      title: `${me.firstName} ${me.lastName} picked up an open shift`,
      body: fmtShift(claimed.startsAt, claimed.endsAt, await companyTz(req.user.companyId)),
      link: { screen: "schedule" },
    });
    return claimed;
  });

  /** The assigned employee asks to give up a published shift; a manager decides. */
  app.post<{ Params: { id: string } }>("/:id/drop-request", async (req) => {
    const { reason } = parse(z.object({ reason: z.string().optional() }), req.body ?? {});
    const shift = await loadShift(req.user.companyId, req.params.id);
    if (shift.employeeId !== req.user.sub) throw new HttpError(403, "This isn't your shift");
    if (shift.status !== "published") throw new HttpError(409, "This shift isn't published yet");
    if (shift.startsAt <= new Date()) throw new HttpError(409, "This shift has already started");
    if (shift.dropRequestedAt) throw new HttpError(409, "You already asked to drop this shift");
    const [row] = await db
      .update(shifts)
      .set({ dropRequestedAt: new Date(), dropReason: reason ?? null })
      .where(eq(shifts.id, shift.id))
      .returning();

    const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    notify(req.user.companyId, except(await approversFor(req.user.companyId, req.user.sub, AREA), req.user.sub), {
      category: "schedule",
      title: `${me.firstName} ${me.lastName} wants to drop a shift`,
      body: `${fmtShift(shift.startsAt, shift.endsAt, await companyTz(req.user.companyId))}${reason ? `: ${reason}` : ""}`,
      link: { screen: "schedule" },
    });
    return row;
  });

  /** Approving turns the shift into an open shift for someone else to pick up. */
  app.post<{ Params: { id: string } }>("/:id/drop-decision", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const shift = await loadShift(req.user.companyId, req.params.id);
    if (!shift.dropRequestedAt || !shift.employeeId) throw new HttpError(409, "No pending drop request for this shift");
    const [row] = await db
      .update(shifts)
      .set({ dropRequestedAt: null, dropReason: null, ...(approve ? { employeeId: null } : {}) })
      .where(eq(shifts.id, shift.id))
      .returning();

    notify(req.user.companyId, except([shift.employeeId], req.user.sub), {
      category: "schedule",
      title: approve ? "You're off the hook: shift drop approved" : "Shift drop request denied",
      body: `${fmtShift(shift.startsAt, shift.endsAt, await companyTz(req.user.companyId))}${approve ? "" : ". You're still scheduled."}`,
      link: { screen: "schedule" },
    });
    if (approve) await announceOpenShifts(req, 1, [shift.employeeId]);
    return row;
  });
};

/** Lets the team know there are shifts up for grabs. */
async function announceOpenShifts(req: FastifyRequest, count: number, skip: string[] = []) {
  const everyone = await staffWithRole(req.user.companyId, "employee", AREA);
  notify(req.user.companyId, except(everyone.filter((id) => !skip.includes(id)), req.user.sub), {
    category: "schedule",
    title: count > 1 ? `${count} open shifts available` : "An open shift is available",
    body: "First come, first served. Open the schedule to pick it up.",
    link: { screen: "schedule" },
  });
}

export default routes;
