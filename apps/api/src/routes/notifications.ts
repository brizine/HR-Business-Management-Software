import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  NOTIFICATION_CATEGORIES,
  defaultPreference,
  deviceSchema,
  hasRole,
  notificationPreferencesSchema,
  toE164,
  type NotificationPreference,
} from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { companies, employees, notificationPreferences, notifications, pushTokens } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { emailTransport, smsTransport } from "../lib/channels";
import { HttpError, notFound, parse } from "../lib/errors";

/** Everyone manages their own settings; admins can also set them for staff without a login. */
async function targetEmployee(req: FastifyRequest<{ Querystring: { employeeId?: string } }>) {
  const id = req.query.employeeId ?? req.user.sub;
  if (id !== req.user.sub && !hasRole(req.user.role, "admin")) throw new HttpError(403, "You can only change your own notification settings");
  const [emp] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, id), eq(employees.companyId, req.user.companyId)));
  if (!emp) notFound("Employee");
  return emp;
}

async function preferencesFor(emp: typeof employees.$inferSelect) {
  const [[company], rows, devices] = await Promise.all([
    db.select().from(companies).where(eq(companies.id, emp.companyId)),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.employeeId, emp.id)),
    db.select({ n: count() }).from(pushTokens).where(eq(pushTokens.employeeId, emp.id)),
  ]);
  return {
    employee: {
      id: emp.id,
      firstName: emp.firstName,
      lastName: emp.lastName,
      email: emp.email,
      phone: emp.phone,
      smsOptIn: !!emp.smsOptInAt,
      smsOptInAt: emp.smsOptInAt,
      phoneTextable: !!toE164(emp.phone),
    },
    hasApp: devices[0].n > 0,
    channels: { email: !!emailTransport(), sms: !!smsTransport() && company.smsEnabled },
    preferences: NOTIFICATION_CATEGORIES.map(
      (c) => (rows.find((r) => r.category === c) as NotificationPreference | undefined) ?? defaultPreference(c),
    ).map(({ category, app, email, sms }) => ({ category, app, email, sms })),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  const unreadCount = async (employeeId: string) => {
    const [{ n }] = await db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.employeeId, employeeId), isNull(notifications.readAt)));
    return n;
  };

  app.get("/", async (req) => {
    const items = await db
      .select()
      .from(notifications)
      .where(eq(notifications.employeeId, req.user.sub))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return { items, unread: await unreadCount(req.user.sub) };
  });

  app.get("/unread-count", async (req) => ({ unread: await unreadCount(req.user.sub) }));

  app.post<{ Params: { id: string } }>("/:id/read", async (req) => {
    const [row] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, req.params.id), eq(notifications.employeeId, req.user.sub)))
      .returning();
    if (!row) notFound("Notification");
    return row;
  });

  app.post("/read-all", async (req) => {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.employeeId, req.user.sub), isNull(notifications.readAt)));
    return { ok: true };
  });

  app.get<{ Querystring: { employeeId?: string } }>("/preferences", async (req) => preferencesFor(await targetEmployee(req)));

  app.put<{ Querystring: { employeeId?: string } }>("/preferences", async (req) => {
    const body = parse(notificationPreferencesSchema, req.body);
    const emp = await targetEmployee(req);
    if (body.smsOptIn !== undefined && body.smsOptIn !== !!emp.smsOptInAt) {
      if (body.smsOptIn && !toE164(emp.phone)) throw new HttpError(400, "Add a mobile phone number before turning on texts");
      await db
        .update(employees)
        .set({ smsOptInAt: body.smsOptIn ? new Date() : null })
        .where(eq(employees.id, emp.id));
    }
    for (const p of body.preferences ?? []) {
      const values = { companyId: emp.companyId, employeeId: emp.id, ...p };
      await db
        .insert(notificationPreferences)
        .values(values)
        .onConflictDoUpdate({ target: [notificationPreferences.employeeId, notificationPreferences.category], set: values });
    }
    const [updated] = await db.select().from(employees).where(eq(employees.id, emp.id));
    return preferencesFor(updated);
  });

  /** Company-wide delivery settings and whether email/SMS providers are configured on the server. */
  app.get("/company-settings", { preHandler: requireRole("admin") }, async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return { smsEnabled: c.smsEnabled, emailConfigured: !!emailTransport(), smsConfigured: !!smsTransport() };
  });

  app.put("/company-settings", { preHandler: requireRole("owner") }, async (req) => {
    const { smsEnabled } = parse(z.object({ smsEnabled: z.boolean() }), req.body);
    const [c] = await db.update(companies).set({ smsEnabled }).where(eq(companies.id, req.user.companyId)).returning();
    return { smsEnabled: c.smsEnabled, emailConfigured: !!emailTransport(), smsConfigured: !!smsTransport() };
  });

  /** Registers this device for push. Re-registering moves the token to the current user. */
  app.post("/devices", async (req) => {
    const body = parse(deviceSchema, req.body);
    const values = { ...body, employeeId: req.user.sub, companyId: req.user.companyId, lastSeenAt: new Date() };
    const [row] = await db
      .insert(pushTokens)
      .values(values)
      .onConflictDoUpdate({ target: pushTokens.token, set: values })
      .returning();
    return { id: row.id };
  });

  /** Called on sign-out so the device stops receiving this user's alerts. */
  app.post("/devices/remove", async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.body);
    await db.delete(pushTokens).where(and(eq(pushTokens.token, token), eq(pushTokens.employeeId, req.user.sub)));
    return { ok: true };
  });
};

export default routes;
