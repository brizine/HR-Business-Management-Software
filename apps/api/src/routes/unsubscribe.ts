import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { NOTIFICATION_CATEGORY_INFO, defaultPreference } from "@crewdesk/shared";
import { db } from "../db";
import { employees, notificationPreferences } from "../db/schema";
import { readUnsubscribeToken } from "../lib/channels";
import { HttpError } from "../lib/errors";

/**
 * Unsubscribe links in emails. No login needed: the signed token says who
 * and which category. Supports RFC 8058 one-click (POST from the mail client).
 */
const routes: FastifyPluginAsync = async (app) => {
  // Mail clients send one-click unsubscribes as a form post.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post<{ Querystring: { token?: string }; Body: { token?: string } | string }>("/", async (req) => {
    const token = req.query.token ?? (typeof req.body === "object" ? req.body?.token : undefined);
    const parsed = token ? readUnsubscribeToken(token) : null;
    if (!parsed || !(parsed.category in NOTIFICATION_CATEGORY_INFO)) throw new HttpError(400, "This unsubscribe link is invalid");
    const [emp] = await db.select().from(employees).where(eq(employees.id, parsed.employeeId));
    if (!emp) throw new HttpError(400, "This unsubscribe link is invalid");

    const [existing] = await db
      .select()
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.employeeId, emp.id), eq(notificationPreferences.category, parsed.category)));
    const base = existing ?? { ...defaultPreference(parsed.category), companyId: emp.companyId, employeeId: emp.id };
    const values = { ...base, email: "never" };
    await db
      .insert(notificationPreferences)
      .values(values)
      .onConflictDoUpdate({ target: [notificationPreferences.employeeId, notificationPreferences.category], set: values });
    return { ok: true, category: parsed.category, label: NOTIFICATION_CATEGORY_INFO[parsed.category].label, email: emp.email };
  });
};

export default routes;
