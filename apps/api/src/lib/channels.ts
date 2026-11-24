import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { NotificationCategory } from "@crewdesk/shared";

export const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

// ---------- Email ----------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  /** Files to attach (e.g. an invoice PDF). */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /** Where replies go (e.g. the company's own email, for invoices). */
  replyTo?: string;
  /** Shown as the sender's name, e.g. the company name (the address stays EMAIL_FROM's). */
  fromName?: string;
  cc?: string[];
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Addresses on the reserved ".invalid" domain (test-company sign-ins) never get mail. */
export const isUndeliverable = (to: string) => /\.invalid>?\s*$/i.test(to.trim());

/** Any SMTP provider (Postmark, SendGrid, SES, Mailgun, Google Workspace…) via SMTP_URL. */
class SmtpEmail implements EmailTransport {
  private transporter = nodemailer.createTransport(process.env.SMTP_URL);
  async send(msg: EmailMessage) {
    // Test-company sign-ins use ".invalid" addresses, which can never receive mail; don't try.
    if (isUndeliverable(msg.to)) return;
    const { fromName, cc, ...rest } = msg;
    const configured = process.env.EMAIL_FROM ?? "Crewdesk <no-reply@example.com>";
    const address = configured.match(/<([^>]+)>/)?.[1] ?? configured;
    const from = fromName ? { name: fromName, address } : configured;
    await this.transporter.sendMail({ ...rest, from, ...(cc?.length ? { cc: cc.filter((a) => !isUndeliverable(a)) } : {}) });
  }
}

let email: EmailTransport | null = process.env.SMTP_URL ? new SmtpEmail() : null;

/** Notes each email in email_log (sent, or refused with the reason) for Email deliverability; never stops a send. */
async function logEmail(to: string, subject: string, error: unknown) {
  try {
    const { db } = await import("../db");
    const { emailLog } = await import("../db/schema");
    await db.insert(emailLog).values({ to: to.trim().toLowerCase().slice(0, 320), subject: subject.slice(0, 300), status: error ? "failed" : "sent", error: error ? String((error as Error).message ?? error).slice(0, 500) : null });
  } catch { /* the log is a nicety */ }
}
function logged(t: EmailTransport): EmailTransport {
  return {
    async send(msg) {
      if (isUndeliverable(msg.to)) return t.send(msg);
      try { await t.send(msg); } catch (e) { await logEmail(msg.to, msg.subject, e); throw e; }
      await logEmail(msg.to, msg.subject, null);
    },
  };
}
let wrapped: { of: EmailTransport; as: EmailTransport } | null = null;

/** Null when email isn't configured; callers skip the channel. Sends are noted in email_log. */
export const emailTransport = () => {
  if (!email) return null;
  if (wrapped?.of !== email) wrapped = { of: email, as: logged(email) };
  return wrapped.as;
};
export function setEmailTransport(t: EmailTransport | null) {
  email = t;
}

/** Account emails (password resets) that don't go through notification preferences. */
export async function sendSystemEmail(to: string, subject: string, text: string, html: string) {
  if (!email) {
    console.warn(`Email isn't configured (SMTP_URL); couldn't send "${subject}" to ${to}`);
    return false;
  }
  await emailTransport()!.send({ to, subject, text, html });
  return true;
}

// ---------- SMS ----------

export class SmsError extends Error {
  constructor(public code: number | undefined, message: string) {
    super(message);
  }
}

/** Twilio error code for a number that replied STOP. */
export const SMS_UNSUBSCRIBED = 21610;

export interface SmsTransport {
  send(to: string, body: string): Promise<void>;
}

/**
 * Twilio Programmable Messaging. Use a Messaging Service (TWILIO_MESSAGING_SERVICE_SID)
 * so Twilio handles STOP/HELP replies; US numbers also need A2P 10DLC registration.
 */
class TwilioSms implements SmsTransport {
  async send(to: string, body: string) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const sender: Record<string, string> = process.env.TWILIO_MESSAGING_SERVICE_SID
      ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID }
      : { From: process.env.TWILIO_FROM ?? "" };
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, Body: body, ...sender }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
      throw new SmsError(err.code, err.message ?? `Twilio error ${res.status}`);
    }
  }
}

let sms: SmsTransport | null =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? new TwilioSms() : null;

export const smsTransport = () => sms;
export function setSmsTransport(t: SmsTransport | null) {
  sms = t;
}

// ---------- Unsubscribe links ----------

const secret = () => process.env.JWT_SECRET ?? "dev-only-secret";
const sign = (payload: string) => createHmac("sha256", secret()).update(`unsubscribe:${payload}`).digest("base64url");

/** A link token that turns off one category's emails for one person. It doesn't expire. */
export function unsubscribeToken(employeeId: string, category: NotificationCategory) {
  const payload = Buffer.from(JSON.stringify({ e: employeeId, c: category })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readUnsubscribeToken(token: string): { employeeId: string; category: NotificationCategory } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { e, c } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return { employeeId: e, category: c };
  } catch {
    return null;
  }
}
