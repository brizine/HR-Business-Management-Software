import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_HOLIDAY_RULES,
  HOLIDAY_PRESETS,
  holidayRulesSchema,
  holidaySchema,
  holidaysBetween,
  type HolidayObserve,
  type HolidayRules,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, holidays } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { localParts } from "../lib/tz";

/** Paid holidays live on the Time off page, so its access level controls them. */
const AREA = "timeoff" as const;

const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function holidayRulesFor(companyId: string): Promise<HolidayRules> {
  const [c] = await db.select({ rules: companies.holidayRules }).from(companies).where(eq(companies.id, companyId));
  return { ...DEFAULT_HOLIDAY_RULES, ...(c?.rules ?? {}) };
}

export async function holidayList(companyId: string) {
  const rows = await db.select().from(holidays).where(eq(holidays.companyId, companyId)).orderBy(asc(holidays.createdAt));
  return rows.map((h) => ({ ...h, observe: h.observe as HolidayObserve }));
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Everyone: the holiday list, the rules, and the next 12 months of days off. */
  app.get<{ Querystring: { from?: string; to?: string } }>("/", async (req) => {
    const [c] = await db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, req.user.companyId));
    const today = localParts(new Date(), c.timezone).date;
    const list = await holidayList(req.user.companyId);
    const { from, to } = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const start = from ?? today;
    const end = to ?? addDays(today, 365);
    if (end < start || Date.parse(end) - Date.parse(start) > 3 * 366 * 86_400_000) throw new HttpError(400, "Pick a range of up to 3 years");
    return {
      holidays: list,
      rules: await holidayRulesFor(req.user.companyId),
      upcoming: holidaysBetween(list, start, end).map((o) => ({ holidayId: o.holiday.id, name: o.holiday.name, hours: o.holiday.hours, date: o.date, observed: o.observed })),
    };
  });

  app.post("/", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(holidaySchema, req.body);
    const [row] = await db.insert(holidays).values({ ...body, companyId: req.user.companyId }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(holidaySchema, req.body);
    const [row] = await db.update(holidays).set(body).where(and(eq(holidays.id, req.params.id), eq(holidays.companyId, req.user.companyId))).returning();
    if (!row) notFound("Holiday");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const [row] = await db.delete(holidays).where(and(eq(holidays.id, req.params.id), eq(holidays.companyId, req.user.companyId))).returning();
    if (!row) notFound("Holiday");
    return { ok: true };
  });

  /** Adds common US holidays by key (skipping any already on the list by name). */
  app.post("/presets", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { keys, hours } = parse(z.object({ keys: z.array(z.string()).min(1).max(HOLIDAY_PRESETS.length), hours: z.number().min(0).max(24).default(8) }), req.body);
    const existing = new Set((await holidayList(req.user.companyId)).map((h) => h.name.toLowerCase()));
    const add = HOLIDAY_PRESETS.filter((p) => keys.includes(p.key) && !existing.has(p.name.toLowerCase()));
    if (add.length) await db.insert(holidays).values(add.map((p) => ({ companyId: req.user.companyId, name: p.name, rule: p.rule, hours, observe: "nearest" })));
    return { added: add.length };
  });

  /** Who gets holiday pay and what working a holiday pays. */
  app.put("/rules", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const rules = parse(holidayRulesSchema, req.body);
    await db.update(companies).set({ holidayRules: rules }).where(eq(companies.id, req.user.companyId));
    return rules;
  });
};

export default routes;
