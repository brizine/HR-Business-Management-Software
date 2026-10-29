import { and, eq, inArray, ne } from "drizzle-orm";
import { hasRole, type NotificationCategory, type NotificationLink, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { employees, notifications, pushTokens } from "../db/schema";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { notificationId: string; link: NotificationLink | null };
  sound: "default";
  channelId: "default";
}

export type PushTicket = { status: "ok"; id: string } | { status: "error"; message: string; details?: { error?: string } };

export interface PushTransport {
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

/** Expo's push service, which relays to APNs (iOS) and FCM (Android). */
export class ExpoPushTransport implements PushTransport {
  async send(messages: PushMessage[]) {
    const tickets: PushTicket[] = [];
    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
      if (!res.ok) throw new Error(`Expo push failed ${res.status}: ${await res.text()}`);
      tickets.push(...((await res.json()) as { data: PushTicket[] }).data);
    }
    return tickets;
  }
}

let transport: PushTransport = new ExpoPushTransport();

/** Swap the transport (tests use an in-memory fake). */
export function setPushTransport(t: PushTransport) {
  transport = t;
}

export interface NotificationInput {
  category: NotificationCategory;
  title: string;
  body: string;
  link?: NotificationLink;
}

const pending = new Set<Promise<void>>();

/**
 * Stores an inbox notification for each recipient and pushes it to their
 * devices. Runs in the background so API responses never wait on Expo;
 * failures are logged, never thrown to the caller.
 */
export function notify(companyId: string, employeeIds: Iterable<string | null | undefined>, n: NotificationInput) {
  const ids = [...new Set([...employeeIds].filter((x): x is string => !!x))];
  if (!ids.length) return;
  const p = deliver(companyId, ids, n)
    .catch((err) => console.error("notify failed", err))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Waits for in-flight notifications (used by tests and graceful shutdown). */
export async function flushNotifications() {
  while (pending.size) await Promise.all([...pending]);
}

async function deliver(companyId: string, employeeIds: string[], n: NotificationInput) {
  // Only notify active staff in this company.
  const recipients = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds), ne(employees.status, "terminated")));
  if (!recipients.length) return;

  const rows = await db
    .insert(notifications)
    .values(recipients.map((r) => ({ companyId, employeeId: r.id, ...n, link: n.link ?? null })))
    .returning();

  const tokens = await db
    .select()
    .from(pushTokens)
    .where(inArray(pushTokens.employeeId, recipients.map((r) => r.id)));
  if (!tokens.length) return;

  const byEmployee = new Map(rows.map((r) => [r.employeeId, r.id]));
  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.token,
    title: n.title,
    body: n.body,
    data: { notificationId: byEmployee.get(t.employeeId)!, link: n.link ?? null },
    sound: "default",
    channelId: "default",
  }));
  const tickets = await transport.send(messages);

  // Tokens for uninstalled apps or revoked permissions are dead; stop sending to them.
  const dead = tickets
    .map((t, i) => (t.status === "error" && t.details?.error === "DeviceNotRegistered" ? messages[i].to : null))
    .filter((x): x is string => !!x);
  if (dead.length) await db.delete(pushTokens).where(inArray(pushTokens.token, dead));
}

/** Active staff at or above `min` role, e.g. everyone who manages the fleet. */
export async function staffWithRole(companyId: string, min: Role) {
  const rows = await db
    .select({ id: employees.id, role: employees.role })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), ne(employees.status, "terminated")));
  return rows.filter((r) => hasRole(r.role as Role, min)).map((r) => r.id);
}

/** Who approves things for an employee: their manager, or the admins if none is set. */
export async function approversFor(companyId: string, employeeId: string) {
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  if (emp?.managerId) return [emp.managerId];
  return staffWithRole(companyId, "admin");
}

/** Removes the person who triggered an event so nobody is notified of their own action. */
export function except(ids: Iterable<string | null | undefined>, actorId: string) {
  return [...ids].filter((id) => id && id !== actorId);
}
