import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  BACK_REASON_LABELS, NOTIFY_BEFORE, hasRole, savedViewSchema, waitBackSchema, waitBulkSchema, waitScheduleSchema,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, crewMembers, crews, customers, properties, savedViews, visitAssignees, visits } from "../db/schema";
import { authenticate, requireRole, roleIn } from "../lib/auth";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { billingSettings } from "../lib/invoices";
import { companyToday } from "../lib/payRates";
import { sendCustomerText, textingConfig } from "../lib/texting";
import { waitingList, workload } from "../lib/waitlist";

const AREA = "customers" as const;
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`; };

/** The waiting list (Crewdesk plan): everything that needs doing with no date yet, and scheduling it. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get<{ Querystring: { upcoming?: string } }>("/", async (req) => {
    const list = await waitingList(req.user.companyId, { upcoming: req.query.upcoming === "1" });
    const crewRows = await db.select({ id: crews.id, name: crews.name, color: crews.color, dailyHours: crews.dailyHours }).from(crews)
      .where(and(eq(crews.companyId, req.user.companyId), eq(crews.active, true))).orderBy(crews.name);
    return { ...list, crews: crewRows };
  });

  /** Hours booked per crew for each day from `from` (7 days), against their hours. */
  app.get<{ Querystring: { from?: string; days?: string } }>("/workload", async (req) => {
    const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : await companyToday(req.user.companyId);
    return workload(req.user.companyId, from, Math.min(14, Math.max(1, Number(req.query.days) || 7)));
  });

  /**
   * Edit work orders: puts the selection on a date (and crew, window). Refuses ones that need a card
   * on file, and ones before their eligible-from date unless a reason is given (it's recorded).
   */
  app.post("/schedule", async (req) => {
    const b = parse(waitScheduleSchema, req.body);
    const { companyId, sub } = req.user;
    if (b.crewId) {
      const [c] = await db.select({ id: crews.id }).from(crews).where(and(eq(crews.id, b.crewId), eq(crews.companyId, companyId)));
      if (!c) throw new HttpError(400, "That crew isn't in your company");
    }
    const { rows } = await waitingList(companyId, { ids: b.visitIds });
    if (rows.length !== b.visitIds.length) throw new HttpError(404, "Some of those work orders weren't found");
    const closed = rows.filter((r) => r.status !== "open");
    if (closed.length) throw new HttpError(400, `${closed.length} of those ${closed.length === 1 ? "is" : "are"} already done or skipped`);
    const needCard = rows.filter((r) => r.needsCard);
    if (needCard.length) throw new HttpError(409, `No card on file for ${[...new Set(needCard.map((r) => r.customer.name))].slice(0, 5).join(", ")}${needCard.length > 5 ? "…" : ""}. Add one, or turn the requirement off for them, first`);
    const early = rows.filter((r) => r.eligible && b.date < r.eligible);
    if (early.length && !b.earlyReason) {
      throw new HttpError(400, `${early.length} ${early.length === 1 ? "isn't" : "aren't"} eligible until later (minimum days since the last service). Give a reason to schedule ${early.length === 1 ? "it" : "them"} early`);
    }
    const members = b.crewId ? (await db.select({ id: crewMembers.employeeId }).from(crewMembers).where(eq(crewMembers.crewId, b.crewId))).map((m) => m.id) : [];
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const isEarly = early.some((e) => e.id === r.id);
        await tx.update(visits).set({
          date: b.date, endDate: null, waitingSince: null, backReason: null,
          ...(b.crewId !== undefined ? { crewId: b.crewId ?? null } : {}),
          ...(b.windowStart !== undefined ? { windowStart: b.windowStart ?? null, windowEnd: b.windowStart ? b.windowEnd ?? null : null } : {}),
          ...(isEarly ? { earlyReason: b.earlyReason!, earlyById: sub, earlyAt: new Date() } : {}),
          updatedAt: new Date(),
        }).where(eq(visits.id, r.id));
        // The crew's people do it, unless people were picked already.
        if (members.length) {
          const has = await tx.select({ id: visitAssignees.employeeId }).from(visitAssignees).where(eq(visitAssignees.visitId, r.id));
          if (!has.length) await tx.insert(visitAssignees).values(members.map((employeeId) => ({ visitId: r.id, employeeId }))).onConflictDoNothing();
        }
        if (b.makePreferred && b.crewId) await tx.update(properties).set({ preferredCrewId: b.crewId }).where(eq(properties.id, r.property.id));
      }
    });
    // Tell the customers who want a text ahead (when texting is on); list the ones to call.
    let texted = 0, notTexted = 0;
    const toCall: string[] = [];
    if (b.notify) {
      const [co] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      const texting = !!(await textingConfig(companyId));
      for (const r of rows) {
        const pref = (await db.select({ p: properties.notifyBefore }).from(properties).where(eq(properties.id, r.property.id)))[0]?.p ?? r.customer.notifyBefore;
        if (pref === "call") toCall.push(r.customer.name);
        if (pref !== "text") continue;
        if (!texting) { notTexted++; continue; }
        const window = b.windowStart ? ` ${b.windowEnd ? `between ${time12(b.windowStart)} and ${time12(b.windowEnd)}` : `after ${time12(b.windowStart)}`}` : "";
        const s = await sendCustomerText(companyId, r.customer.id, `${co.name}: we're scheduled for ${r.service.name.toLowerCase()} at ${r.property.street} on ${longDay(b.date)}${window}. Reply STOP to opt out.`, { by: sub, source: "office" });
        if (s.text && s.text.status !== "failed") texted++; else notTexted++;
      }
    }
    return { scheduled: rows.length, early: early.length, texted, notTexted, toCall: [...new Set(toCall)] };
  });

  /** Back to the waiting list (rain, no access…), with the reason. */
  app.post("/back", async (req) => {
    const b = parse(waitBackSchema, req.body);
    const rows = await db.select({ id: visits.id, status: visits.status }).from(visits).where(and(eq(visits.companyId, req.user.companyId), inArray(visits.id, b.visitIds)));
    if (rows.length !== b.visitIds.length) throw new HttpError(404, "Some of those work orders weren't found");
    if (rows.some((r) => r.status === "completed")) throw new HttpError(400, "Completed work orders can't go back to the waiting list");
    const reason = `${BACK_REASON_LABELS[b.reason]}${b.note ? `: ${b.note}` : ""}`;
    await db.update(visits).set({ date: null, endDate: null, startTime: null, endTime: null, status: "open", startedAt: null, waitingSince: new Date(), backReason: reason, updatedAt: new Date() })
      .where(and(eq(visits.companyId, req.user.companyId), inArray(visits.id, b.visitIds)));
    return { moved: rows.length };
  });

  /** Skip, delete or set the priority of the selection. */
  app.post("/bulk", async (req) => {
    const b = parse(waitBulkSchema, req.body);
    const { companyId, sub } = req.user;
    const rows = await db.select({ id: visits.id, status: visits.status, invoiceId: visits.invoiceId }).from(visits).where(and(eq(visits.companyId, companyId), inArray(visits.id, b.visitIds)));
    if (rows.length !== b.visitIds.length) throw new HttpError(404, "Some of those work orders weren't found");
    const open = rows.filter((r) => r.status === "open").map((r) => r.id);
    if (b.action === "priority") await db.update(visits).set({ priority: b.priority!, updatedAt: new Date() }).where(inArray(visits.id, b.visitIds));
    if (b.action === "skip") await db.update(visits).set({ status: "skipped", skippedAt: new Date(), finishedById: sub, skipReason: b.reason!, updatedAt: new Date() }).where(inArray(visits.id, open));
    if (b.action === "delete") {
      if (!hasRole(roleIn(req, AREA), "admin")) throw new HttpError(403, "Only admins can delete work orders");
      const deletable = rows.filter((r) => r.status === "open" && !r.invoiceId).map((r) => r.id);
      if (deletable.length) await db.delete(visits).where(inArray(visits.id, deletable));
      return { done: deletable.length, kept: rows.length - deletable.length };
    }
    return { done: b.action === "priority" ? rows.length : open.length, kept: b.action === "priority" ? 0 : rows.length - open.length };
  });

  /* ── Preferences: notify-before, preferred crew, card on file ── */

  app.put<{ Params: { id: string } }>("/customer/:id", async (req) => {
    const b = parse(z.object({ notifyBefore: z.enum(NOTIFY_BEFORE) }), req.body);
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    await db.update(customers).set({ notifyBefore: b.notifyBefore, updatedAt: new Date() }).where(eq(customers.id, c.id));
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/property/:id", async (req) => {
    const b = parse(z.object({ notifyBefore: z.enum(NOTIFY_BEFORE).nullable(), preferredCrewId: z.string().uuid().nullable() }), req.body);
    const [p] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, req.params.id), eq(properties.companyId, req.user.companyId)));
    if (!p) throw new HttpError(404, "Property not found");
    if (b.preferredCrewId) {
      const [c] = await db.select({ id: crews.id }).from(crews).where(and(eq(crews.id, b.preferredCrewId), eq(crews.companyId, req.user.companyId)));
      if (!c) throw new HttpError(400, "That crew isn't in your company");
    }
    await db.update(properties).set({ notifyBefore: b.notifyBefore, preferredCrewId: b.preferredCrewId, updatedAt: new Date() }).where(eq(properties.id, p.id));
    return { ok: true };
  });

  /** Turn the card-on-file requirement off (with why) or back on, for a customer or one property. */
  app.put("/card-exempt", async (req) => {
    const b = parse(z.object({ customerId: z.string().uuid().optional(), propertyId: z.string().uuid().optional(), exempt: z.boolean(), reason: z.string().trim().max(300).optional() })
      .refine((v) => !!v.customerId !== !!v.propertyId, "Pick a customer or a property").refine((v) => !v.exempt || !!v.reason, { message: "Say why (e.g. net 30, pays by check)", path: ["reason"] }), req.body);
    const set = b.exempt ? { cardExemptReason: b.reason!, cardExemptById: req.user.sub, cardExemptAt: new Date() } : { cardExemptReason: null, cardExemptById: null, cardExemptAt: null };
    if (b.customerId) {
      const c = await customerInCompany(db, req.user.companyId, b.customerId);
      await db.update(customers).set({ ...set, updatedAt: new Date() }).where(eq(customers.id, c.id));
    } else {
      const [p] = await db.update(properties).set({ ...set, updatedAt: new Date() }).where(and(eq(properties.id, b.propertyId!), eq(properties.companyId, req.user.companyId))).returning({ id: properties.id });
      if (!p) throw new HttpError(404, "Property not found");
    }
    return { ok: true };
  });

  /** The company setting: card on file required before scheduling. */
  app.put("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const b = parse(z.object({ requireCardOnFile: z.boolean() }), req.body);
    const current = await billingSettings(req.user.companyId);
    await db.update(companies).set({ billing: { ...current, requireCardOnFile: b.requireCardOnFile } }).where(eq(companies.id, req.user.companyId));
    return b;
  });

  /* ── Saved views ── */

  app.get<{ Querystring: { page?: string } }>("/views", async (req) => {
    const page = req.query.page ?? "waitlist";
    const rows = await db.select().from(savedViews).where(and(eq(savedViews.companyId, req.user.companyId), eq(savedViews.page, page), or(isNull(savedViews.ownerId), eq(savedViews.ownerId, req.user.sub)))).orderBy(savedViews.name);
    return rows.map((v) => ({ id: v.id, name: v.name, shared: !v.ownerId, mine: v.ownerId === req.user.sub, config: v.config }));
  });

  app.post("/views", async (req) => {
    const b = parse(savedViewSchema, req.body);
    const [v] = await db.insert(savedViews).values({ companyId: req.user.companyId, page: b.page, name: b.name, ownerId: b.shared ? null : req.user.sub, config: b.config }).returning();
    return { id: v.id, name: v.name, shared: !v.ownerId, mine: true, config: v.config };
  });

  app.delete<{ Params: { id: string } }>("/views/:id", async (req) => {
    const [v] = await db.select().from(savedViews).where(and(eq(savedViews.id, req.params.id), eq(savedViews.companyId, req.user.companyId)));
    if (!v) throw new HttpError(404, "View not found");
    if (v.ownerId ? v.ownerId !== req.user.sub : !hasRole(roleIn(req, AREA), "admin")) throw new HttpError(403, v.ownerId ? "That's someone else's view" : "Only admins can delete a shared view");
    await db.delete(savedViews).where(eq(savedViews.id, v.id));
    return { ok: true };
  });
};

export default routes;
