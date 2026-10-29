import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { companies, employees, passwordResets } from "../db/schema";
import { WEB_URL, emailTransport, sendSystemEmail } from "./channels";
import { randomToken, sha256 } from "./crypto";

export const INVITE_TTL_DAYS = 7;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Emails a new hire a one-time link (valid 7 days) to choose their password.
 * Earlier invites stop working. Returns the link too, so an admin can text it
 * when email isn't set up.
 */
export async function sendInvite(employee: typeof employees.$inferSelect, invitedBy?: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, employee.companyId));
  const token = randomToken();
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.employeeId, employee.id), eq(passwordResets.purpose, "invite"), isNull(passwordResets.usedAt)));
  await db.insert(passwordResets).values({
    employeeId: employee.id,
    purpose: "invite",
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
  });
  await db.update(employees).set({ invitedAt: new Date() }).where(eq(employees.id, employee.id));

  const link = `${WEB_URL}/welcome?token=${token}`;
  const from = invitedBy ? ` ${invitedBy} has` : "";
  const start = employee.startDate ? ` Your start date is ${employee.startDate}.` : "";
  let emailed = false;
  if (emailTransport()) {
    emailed = await sendSystemEmail(
      employee.email,
      `Welcome to ${company.name}: set up your Biz Management Software account`,
      `Hi ${employee.firstName},\n\n${from ? from.trim() + " invited" : "You've been invited"} you to Biz Management Software, where ${company.name} handles schedules, time off and new-hire paperwork.${start}\n\nChoose your password here (the link works for ${INVITE_TTL_DAYS} days):\n${link}\n\nThen you'll see your onboarding checklist. You can also install the Biz Management Software app on your phone.`,
      `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1c2330">
<p style="font-size:18px;font-weight:600">Welcome to ${escapeHtml(company.name)}, ${escapeHtml(employee.firstName)}!</p>
<p>${from ? escapeHtml(from.trim()) + " invited" : "You've been invited"} you to Biz Management Software, where ${escapeHtml(company.name)} handles schedules, time off and new-hire paperwork.${escapeHtml(start)}</p>
<p><a href="${link}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:7px;text-decoration:none">Set up my account</a></p>
<p style="color:#667085;font-size:13px">The link works for ${INVITE_TTL_DAYS} days. Afterwards you'll see your onboarding checklist.</p></div>`,
    ).catch(() => false);
  }
  return { emailed, link };
}
