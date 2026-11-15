import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import { holidaysBetween, isInactive } from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, employees, jobSites, ptoPolicies, ptoRequests, shifts } from "../db/schema";
import { buildIcs, type IcsEvent } from "../lib/ics";
import { holidayList } from "./holidays";

const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * Public calendar feed (no sign-in: the secret in the link is the key). Phone calendars fetch
 * /calendar/<token>.ics every hour or so: that person's published shifts from 60 days ago to 6
 * months ahead, their approved time off, and the company's paid holidays.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { file: string } }>("/:file", async (req, reply) => {
    const token = req.params.file.replace(/\.ics$/, "");
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return reply.code(404).send({ error: "Not found" });
    const [emp] = await db.select().from(employees).where(eq(employees.calendarToken, token));
    if (!emp || isInactive(emp.status)) return reply.code(404).send({ error: "This calendar link no longer works" });
    const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, emp.companyId));
    const now = Date.now();
    const from = new Date(now - 60 * DAY), to = new Date(now + 183 * DAY);
    const rows = await db.select({ s: shifts, assetName: assets.name, siteAddress: jobSites.address, siteName: jobSites.name }).from(shifts)
      .leftJoin(assets, eq(assets.id, shifts.assetId))
      .leftJoin(jobSites, and(eq(jobSites.companyId, shifts.companyId), eq(jobSites.name, shifts.location)))
      .where(and(eq(shifts.employeeId, emp.id), eq(shifts.status, "published"), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
      .orderBy(asc(shifts.startsAt));
    const events: IcsEvent[] = rows.map(({ s, assetName, siteAddress }) => ({
      uid: `shift-${s.id}@crewdesk`,
      summary: `Work${s.position ? `: ${s.position}` : ""}${s.location ? ` @ ${s.location}` : ""}`,
      location: siteAddress ?? s.location,
      description: [assetName && `Vehicle: ${assetName}`, s.notes].filter(Boolean).join("\n") || null,
      start: s.startsAt,
      end: s.endsAt,
      updated: s.createdAt,
    }));
    const fromDay = from.toISOString().slice(0, 10), toDay = to.toISOString().slice(0, 10);
    const off = await db.select({ r: ptoRequests, policy: ptoPolicies.name }).from(ptoRequests)
      .innerJoin(ptoPolicies, eq(ptoPolicies.id, ptoRequests.policyId))
      .where(and(eq(ptoRequests.employeeId, emp.id), eq(ptoRequests.status, "approved"), lte(ptoRequests.startDate, toDay), gte(ptoRequests.endDate, fromDay)));
    for (const { r, policy } of off) {
      events.push({ uid: `timeoff-${r.id}@crewdesk`, summary: `Time off (${policy})`, allDayStart: r.startDate, allDayEndExclusive: addDays(r.endDate, 1) });
    }
    for (const h of holidaysBetween(await holidayList(emp.companyId), fromDay, toDay)) {
      events.push({ uid: `holiday-${h.holiday.id}-${h.date}@crewdesk`, summary: `Paid holiday: ${h.holiday.name}`, allDayStart: h.date, allDayEndExclusive: addDays(h.date, 1) });
    }
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    reply.header("Cache-Control", "private, max-age=300");
    return buildIcs(`${company?.name ?? "Crewdesk"} shifts`, events);
  });
};

export default routes;
