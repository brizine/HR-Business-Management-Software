import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { weatherReadingSchema, weatherSettingsSchema } from "@crewdesk/shared";
import { db } from "../db";
import { companies, visits, weatherDays } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { addDaysYmd } from "../lib/tz";
import { applyDayWeather, fetchAutoWeather, setOfficeWeather, weatherDayList, weatherRecords, weatherSettings } from "../lib/weather";

const AREA = "customers" as const;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** Weather on chemical applications, for the office (Customers & billing managers). */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get("/settings", async (req) => weatherSettings(req.user.companyId));
  app.put("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const b = parse(weatherSettingsSchema, req.body);
    // The forecast box's links live beside the mode: they stay as they are.
    const [co] = await db.select({ weather: companies.weather }).from(companies).where(eq(companies.id, req.user.companyId));
    await db.update(companies).set({ weather: { ...(co?.weather ?? {}), ...b } }).where(eq(companies.id, req.user.companyId));
    return b;
  });

  /** Completed chemical work orders and their weather, with what needs the office. */
  app.get<{ Querystring: { from?: string; to?: string } }>("/records", async (req) => {
    const today = await companyToday(req.user.companyId);
    const from = req.query.from && isoDate.test(req.query.from) ? req.query.from : addDaysYmd(today, -13);
    const to = req.query.to && isoDate.test(req.query.to) ? req.query.to : today;
    const { settings, records } = await weatherRecords(req.user.companyId, { from, to });
    return { from, to, today, settings, records, days: await weatherDayList(req.user.companyId, from, to) };
  });

  /** One work order's weather (for its page): whether it's a chemical application, and the reading. */
  app.get<{ Params: { visitId: string } }>("/records/:visitId", async (req) => {
    const { settings, records } = await weatherRecords(req.user.companyId, { visitIds: [req.params.visitId] });
    return { settings, record: records[0] ?? null };
  });

  const completed = async (companyId: string, visitId: string) => {
    const [v] = await db.select({ id: visits.id, status: visits.status }).from(visits).where(and(eq(visits.id, visitId), eq(visits.companyId, companyId)));
    if (!v) throw new HttpError(404, "Work order not found");
    if (v.status !== "completed") throw new HttpError(400, "Weather is recorded once the work order is completed");
    return v;
  };

  /** The office types the weather for one work order. */
  app.put<{ Params: { visitId: string } }>("/records/:visitId", async (req) => {
    const b = parse(weatherReadingSchema, req.body);
    await completed(req.user.companyId, req.params.visitId);
    await setOfficeWeather(req.params.visitId, req.user.companyId, b, req.user.sub);
    return (await weatherRecords(req.user.companyId, { visitIds: [req.params.visitId] })).records[0] ?? null;
  });

  /** Look it up from the National Weather Service now (replaces what's there). */
  app.post<{ Params: { visitId: string } }>("/records/:visitId/fetch", async (req) => {
    await completed(req.user.companyId, req.params.visitId);
    const r = await fetchAutoWeather(req.params.visitId, { force: true });
    if (!r.ok) throw new HttpError(400, r.error);
    return (await weatherRecords(req.user.companyId, { visitIds: [req.params.visitId] })).records[0] ?? null;
  });


  /** The office's weather for a day: applied to that day's applications without their own reading. */
  app.put<{ Params: { date: string } }>("/days/:date", async (req) => {
    if (!isoDate.test(req.params.date)) throw new HttpError(400, "Use a date like 2026-05-01");
    const b = parse(weatherReadingSchema, req.body);
    if (req.params.date > (await companyToday(req.user.companyId))) throw new HttpError(400, "That day hasn't happened yet");
    const values = { windMph: b.windMph, windDeg: b.windDeg ?? null, gustMph: b.gustMph ?? null, tempF: b.tempF ?? null, rainIn: b.rainIn ?? null, note: b.note ?? null, enteredById: req.user.sub, updatedAt: new Date() };
    await db.insert(weatherDays).values({ companyId: req.user.companyId, date: req.params.date, ...values })
      .onConflictDoUpdate({ target: [weatherDays.companyId, weatherDays.date], set: values });
    return { applied: await applyDayWeather(req.user.companyId, req.params.date, req.user.sub) };
  });

  app.delete<{ Params: { date: string } }>("/days/:date", async (req) => {
    if (!isoDate.test(req.params.date)) throw new HttpError(400, "Use a date like 2026-05-01");
    await db.delete(weatherDays).where(and(eq(weatherDays.companyId, req.user.companyId), eq(weatherDays.date, req.params.date)));
    return { cleared: await applyDayWeather(req.user.companyId, req.params.date) };
  });
};

export default routes;
