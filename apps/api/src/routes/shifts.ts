import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, type SQL } from "drizzle-orm";
import {
  WEEKDAYS,
  availabilityConflicts,
  describeRule,
  shiftBaseSchema,
  shiftRangeSchema,
  shiftSchema,
  shiftSegments,
  shiftTemplateSchema,
  type ShiftInput,
} from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { assets, availability, companies, employees, ptoRequests, shiftTemplates, shifts } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { approversFor, except, notify, staffWithRole } from "../lib/notify";
import { fmtShift, localDate, localParts } from "../lib/tz";

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
async function assertNoOverlap(employeeId: string, start: Date, end: Date, ignoreId?: string) {
  const filters: SQL[] = [eq(shifts.employeeId, employeeId), lt(shifts.startsAt, end), gt(shifts.endsAt, start)];
  if (ignoreId) filters.push(ne(shifts.id, ignoreId));
  const [clash] = await db
    .select()
    .from(shifts)
    .where(and(...filters))
    .limit(1);
  if (clash) throw new HttpError(409, "This person already has a shift that overlaps that time");
}

/** Validates references and returns non-blocking warnings (e.g. approved time off that day). */
async function check(companyId: string, s: ShiftInput, ignoreId?: string) {
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
  if (emp.status === "terminated") throw new HttpError(400, `${emp.firstName} ${emp.lastName} is no longer employed`);

  const start = new Date(s.startsAt);
  const end = new Date(s.endsAt);
  await assertNoOverlap(emp.id, start, end, ignoreId);

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
    if (!isManager(req)) filters.push(eq(shifts.status, "published"));
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

  app.get("/templates", { preHandler: requireRole("manager") }, async (req) =>
    db.select().from(shiftTemplates).where(eq(shiftTemplates.companyId, req.user.companyId)).orderBy(asc(shiftTemplates.startTime)),
  );

  async function checkTemplateAsset(companyId: string, assetId?: string | null) {
    if (!assetId) return;
    const [a] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)));
    if (!a) notFound("Asset");
  }

  app.post("/templates", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(shiftTemplateSchema, req.body);
    await checkTemplateAsset(req.user.companyId, body.assetId);
    const [row] = await db.insert(shiftTemplates).values({ ...body, companyId: req.user.companyId }).returning();
    return row;
  });

  app.patch<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("manager") }, async (req) => {
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

  app.delete<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("manager") }, async (req) => {
    const [row] = await db
      .delete(shiftTemplates)
      .where(and(eq(shiftTemplates.id, req.params.id), eq(shiftTemplates.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Template");
    return { ok: true };
  });

  /** Shifts whose employee asked to give them up, awaiting a manager. */
  app.get("/drop-requests", { preHandler: requireRole("manager") }, async (req) =>
    db
      .select({ shift: shifts, employee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName } })
      .from(shifts)
      .innerJoin(employees, eq(employees.id, shifts.employeeId))
      .where(and(eq(shifts.companyId, req.user.companyId), isNotNull(shifts.dropRequestedAt)))
      .orderBy(asc(shifts.startsAt)),
  );

  app.post("/", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(shiftSchema, req.body);
    const warnings = await check(req.user.companyId, body);
    const [shift] = await db
      .insert(shifts)
      .values({ ...toRow(body), companyId: req.user.companyId })
      .returning();
    return { shift, warnings };
  });

  /** Edits a shift. Changes to a published shift are announced to whoever it affects. */
  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager") }, async (req) => {
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

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager") }, async (req) => {
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
  app.post("/publish", { preHandler: requireRole("manager") }, async (req) => {
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
  app.post("/copy-week", { preHandler: requireRole("manager") }, async (req) => {
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
    notify(req.user.companyId, except(await approversFor(req.user.companyId, req.user.sub), req.user.sub), {
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
    notify(req.user.companyId, except(await approversFor(req.user.companyId, req.user.sub), req.user.sub), {
      category: "schedule",
      title: `${me.firstName} ${me.lastName} wants to drop a shift`,
      body: `${fmtShift(shift.startsAt, shift.endsAt, await companyTz(req.user.companyId))}${reason ? `: ${reason}` : ""}`,
      link: { screen: "schedule" },
    });
    return row;
  });

  /** Approving turns the shift into an open shift for someone else to pick up. */
  app.post<{ Params: { id: string } }>("/:id/drop-decision", { preHandler: requireRole("manager") }, async (req) => {
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
  const everyone = await staffWithRole(req.user.companyId, "employee");
  notify(req.user.companyId, except(everyone.filter((id) => !skip.includes(id)), req.user.sub), {
    category: "schedule",
    title: count > 1 ? `${count} open shifts available` : "An open shift is available",
    body: "First come, first served. Open the schedule to pick it up.",
    link: { screen: "schedule" },
  });
}

export default routes;
