import { z } from "zod";
import { fillMessage, type MessageVars } from "./customerMessages";

/**
 * After-application notices (Chemical Tracking): when a chemical work order is completed, the
 * customer hears what was applied and how long to stay off the lawn, the way their property
 * chooses: email, text, a printed notice (left at the door or mailed), or not at all.
 */
export const NOTICE_CHANNELS = ["email", "text", "printed", "none"] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];
export const NOTICE_CHANNEL_LABELS: Record<NoticeChannel, string> = {
  email: "Email", text: "Text", printed: "Printed (door hanger or mail)", none: "No notice",
};
export const NOTICE_STATUS_LABELS: Record<string, string> = {
  sending: "Sending", sent: "Sent", failed: "Didn't send", skipped: "Skipped", to_print: "To print", printed: "Printed",
};

/** Fill-ins for a notice, on top of the customer ones ({first_name}, {company}, {company_phone} …). */
export const NOTICE_FIELDS: [string, string][] = [
  ["application_date", "the day it was applied, e.g. Mar 3, 2027"],
  ["property", "the property's address"],
  ["products", "what was applied, e.g. Pre-Emergent 4FL and Fertilizer 25-0-5"],
  ["instructions", "each product's note for the customer (set on the product)"],
  ["reentry", "how long to stay off the lawn, from the products' re-entry intervals"],
];

export interface ChemicalNoticeSettings {
  /** Off until the company turns notices on, so no customer is surprised. */
  on: boolean;
  emailSubject: string;
  emailBody: string;
  textBody: string;
}
export const DEFAULT_NOTICE_SETTINGS: ChemicalNoticeSettings = {
  on: false,
  emailSubject: "Your lawn was treated on {application_date}",
  emailBody: "Hi {first_name},\n\nWe treated your lawn at {property} on {application_date}.\n\nApplied: {products}\n\n{instructions}\n\n{reentry}\n\nQuestions? Call us at {company_phone}.\n\n{company}",
  textBody: "{company}: we treated your lawn at {property} on {application_date} ({products}). {reentry} Questions? {company_phone}",
};
export const noticeSettingsSchema = z.object({
  on: z.boolean(),
  emailSubject: z.string().trim().min(1, "Enter a subject").max(200),
  emailBody: z.string().trim().min(1, "Write the email").max(5000),
  textBody: z.string().trim().min(1, "Write the text").max(640),
});
export const noticeSettings = (s: Partial<ChemicalNoticeSettings> | null | undefined): ChemicalNoticeSettings => ({ ...DEFAULT_NOTICE_SETTINGS, ...(s ?? {}) });

export interface NoticeProduct { name: string; customerNote: string | null; reiHours: number | null }

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]) {
  const u = [...new Set(names.filter(Boolean))];
  return u.length <= 1 ? u.join("") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

/** How long to stay off: the longest re-entry interval among the products, else until it dries. */
export function reentryText(products: NoticeProduct[]) {
  const hours = Math.max(0, ...products.map((p) => p.reiHours ?? 0));
  if (hours >= 24 && hours % 24 === 0) return `Please keep people and pets off the treated area for ${hours / 24} day${hours === 24 ? "" : "s"}.`;
  if (hours > 0) return `Please keep people and pets off the treated area for ${+hours.toFixed(1)} hour${hours === 1 ? "" : "s"}.`;
  return "Please keep people and pets off the treated area until it has dried.";
}

/** The notice's own fill-ins. */
export function noticeVars(o: { date: string; property: string; products: NoticeProduct[] }): Record<string, string> {
  const notes = o.products.filter((p) => p.customerNote?.trim()).map((p) => `${p.name}: ${p.customerNote!.trim()}`);
  return {
    application_date: new Date(`${o.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
    property: o.property,
    products: joinNames(o.products.map((p) => p.name)),
    instructions: notes.join("\n"),
    reentry: reentryText(o.products),
  };
}

/** A template with the customer's fill-ins and the notice's; blank lines left by empty fill-ins are tidied. */
export function fillNotice(template: string, customer: MessageVars, notice: Record<string, string>) {
  const out = fillMessage(template, customer).replace(/\{\s*([a-z_]+)\s*\}/gi, (all, k: string) => notice[k.toLowerCase()] ?? all);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
