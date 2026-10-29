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
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Any SMTP provider (Postmark, SendGrid, SES, Mailgun, Google Workspace…) via SMTP_URL. */
class SmtpEmail implements EmailTransport {
  private transporter = nodemailer.createTransport(process.env.SMTP_URL);
  async send(msg: EmailMessage) {
    await this.transporter.sendMail({ from: process.env.EMAIL_FROM ?? "Crewdesk <no-reply@example.com>", ...msg });
  }
}

let email: EmailTransport | null = process.env.SMTP_URL ? new SmtpEmail() : null;

/** Null when email isn't configured; callers skip the channel. */
export const emailTransport = () => email;
export function setEmailTransport(t: EmailTransport | null) {
  email = t;
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
