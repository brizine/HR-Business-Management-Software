import { and, eq, inArray, ne } from "drizzle-orm";
import {
  NOTIFICATION_CATEGORY_INFO,
  defaultPreference,
  hasRole,
  toE164,
  webPathFor,
  type DeliveryMode,
  type NotificationCategory,
  type NotificationLink,
  type NotificationPreference,
  type Role,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, notificationPreferences, notifications, pushTokens } from "../db/schema";
import { SmsError, SMS_UNSUBSCRIBED, WEB_URL, PUBLIC_API_URL, emailTransport, smsTransport, unsubscribeToken } from "./channels";

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
 * Delivers to each recipient by the channels their preferences allow:
 * inbox + push, email, and/or text. Runs in the background so API responses never wait on Expo;
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
  const people = await db
    .select()
    .from(employees)
    .where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds), ne(employees.status, "terminated")));
  if (!people.length) return;
  const ids = people.map((p) => p.id);

  const [[company], prefRows, tokens] = await Promise.all([
    db.select().from(companies).where(eq(companies.id, companyId)),
    db
      .select()
      .from(notificationPreferences)
      .where(and(inArray(notificationPreferences.employeeId, ids), eq(notificationPreferences.category, n.category))),
    db.select().from(pushTokens).where(inArray(pushTokens.employeeId, ids)),
  ]);
  const pref = (id: string) => (prefRows.find((r) => r.employeeId === id) as NotificationPreference | undefined) ?? defaultPreference(n.category);
  const hasApp = (id: string) => tokens.some((t) => t.employeeId === id);
  const wants = (mode: DeliveryMode, id: string) => mode === "always" || (mode === "no_app" && !hasApp(id));

  const inApp = people.filter((p) => pref(p.id).app);
  const byEmail = emailTransport() ? people.filter((p) => p.email && wants(pref(p.id).email, p.id)) : [];
  const bySms =
    smsTransport() && company.smsEnabled
      ? people.filter((p) => p.smsOptInAt && toE164(p.phone) && wants(pref(p.id).sms, p.id))
      : [];

  const results = await Promise.allSettled([
    sendInApp(companyId, inApp.map((p) => p.id), tokens, n),
    ...byEmail.map((p) => sendEmail(p, company.name, n)),
    ...bySms.map((p) => sendSms(p, company.name, n)),
  ]);
  for (const r of results) if (r.status === "rejected") console.error("notification delivery failed", r.reason);
}

async function sendInApp(companyId: string, ids: string[], allTokens: (typeof pushTokens.$inferSelect)[], n: NotificationInput) {
  if (!ids.length) return;
  const rows = await db
    .insert(notifications)
    .values(ids.map((employeeId) => ({ companyId, employeeId, ...n, link: n.link ?? null })))
    .returning();
  const tokens = allTokens.filter((t) => ids.includes(t.employeeId));
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

type Person = typeof employees.$inferSelect;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function sendEmail(p: Person, companyName: string, n: NotificationInput) {
  const url = `${WEB_URL}${webPathFor(n.link) ?? "/notifications"}`;
  const settings = `${WEB_URL}/settings/notifications`;
  const token = unsubscribeToken(p.id, n.category);
  const unsubscribe = `${WEB_URL}/unsubscribe?token=${token}`;
  const label = NOTIFICATION_CATEGORY_INFO[n.category].label;
  await emailTransport()!.send({
    to: p.email,
    subject: n.title,
    text: `${n.body}\n\nOpen: ${url}\n\n--\n${companyName} via Crewdesk. Stop ${label.toLowerCase()} emails: ${unsubscribe}\nAll notification settings: ${settings}\n`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1c2330">
<p style="font-size:16px;font-weight:600;margin:0 0 8px">${escapeHtml(n.title)}</p>
<p style="margin:0 0 16px">${escapeHtml(n.body)}</p>
<p><a href="${url}" style="background:#1f6feb;color:#fff;padding:9px 14px;border-radius:7px;text-decoration:none">Open in Crewdesk</a></p>
<p style="color:#667085;font-size:12px;margin-top:24px">${escapeHtml(companyName)} via Crewdesk ·
<a href="${unsubscribe}" style="color:#667085">Stop ${escapeHtml(label.toLowerCase())} emails</a> ·
<a href="${settings}" style="color:#667085">Notification settings</a></p></div>`,
    headers: {
      "List-Unsubscribe": `<${PUBLIC_API_URL}/public/unsubscribe?token=${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

const SMS_MAX = 300;

async function sendSms(p: Person, companyName: string, n: NotificationInput) {
  const path = webPathFor(n.link);
  const suffix = `${path ? ` ${WEB_URL}${path}` : ""} Reply STOP to opt out.`;
  let text = `${companyName}: ${n.title}. ${n.body}`;
  if (text.length + suffix.length > SMS_MAX) text = text.slice(0, SMS_MAX - suffix.length - 1) + "…";
  try {
    await smsTransport()!.send(toE164(p.phone)!, text + suffix);
  } catch (err) {
    // They replied STOP to our number: record the opt-out so we stop trying.
    if (err instanceof SmsError && err.code === SMS_UNSUBSCRIBED) {
      await db.update(employees).set({ smsOptInAt: null }).where(eq(employees.id, p.id));
      return;
    }
    throw err;
  }
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
