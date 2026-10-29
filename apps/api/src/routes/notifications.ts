import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { deviceSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { notifications, pushTokens } from "../db/schema";
import { authenticate } from "../lib/auth";
import { notFound, parse } from "../lib/errors";

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
