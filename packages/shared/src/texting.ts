import { z } from "zod";

/** Texting customers from the company's own number: what can be sent, and how replies are read. */

/** Ten segments' worth, the most Homeworks lets a text be. */
export const TEXT_MAX = 1600;
export const textBodySchema = z.object({
  body: z.string().trim().min(1, "Write the text").max(TEXT_MAX, `Keep it under ${TEXT_MAX} characters`),
});

// The GSM-7 alphabet (plus its extension table, which counts double). Anything else makes the text UCS-2.
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** How many text messages (segments) this body is sent as, and its length as the carrier counts it. */
export function textSegments(body: string): { segments: number; length: number; unicode: boolean } {
  const chars = [...body];
  const unicode = chars.some((c) => !GSM.includes(c) && !GSM_EXT.includes(c));
  const length = unicode ? chars.reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0) : chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
  if (!length) return { segments: 0, length, unicode };
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { segments: length <= single ? 1 : Math.ceil(length / multi), length, unicode };
}

/** Replies that mean "stop texting me" and "start again" (carriers' standard words). */
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES", "OPTIN", "OPT-IN"]);
export function textKeyword(body: string): "stop" | "start" | null {
  const w = body.trim().toUpperCase().replace(/[.!]+$/, "");
  return STOP_WORDS.has(w) ? "stop" : START_WORDS.has(w) && w !== "YES" ? "start" : null;
}

/** Words in a text, as the box under it counts them. */
export const textWords = (body: string) => (body.trim() ? body.trim().split(/\s+/).length : 0);

/** The Text Messages list: every conversation, the unread ones, or those still open / marked done. */
export const TEXT_FILTERS = ["all", "unread", "open", "done"] as const;
export type TextFilter = (typeof TEXT_FILTERS)[number];
export const TEXT_THREAD_STATUSES = ["open", "done"] as const;
export type TextThreadStatus = (typeof TEXT_THREAD_STATUSES)[number];

/** Two letters for the round badge beside a name ("John Example" → "JE"); a phone number gets "#". */
export function textInitials(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /^\d/.test(parts[0])) return "#";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export const TEXT_GROUP_NAME_MAX = 80;
export const textGroupSchema = z.object({ name: z.string().trim().min(1, "Give the group a name").max(TEXT_GROUP_NAME_MAX) });

/** Who a text goes to from the Send Text Messages tab: any mix of customers, employees, groups, crews and typed numbers. */
export const textSendSchema = z.object({
  body: z.string().trim().min(1, "Write the text").max(TEXT_MAX, `Keep it under ${TEXT_MAX} characters`),
  customerIds: z.array(z.string().uuid()).max(5000).default([]),
  employeeIds: z.array(z.string().uuid()).max(1000).default([]),
  groupIds: z.array(z.string().uuid()).max(100).default([]),
  crewIds: z.array(z.string().uuid()).max(100).default([]),
  phones: z.array(z.string().trim().min(7).max(30)).max(100).default([]),
});
export type TextSend = z.infer<typeof textSendSchema>;

/** Why someone on a send was left out. */
export const TEXT_SKIP_REASONS = { no_number: "No mobile number", opted_out: "Replied STOP", sample: "Sample customer", duplicate: "Same number as someone else on the list" } as const;
export type TextSkipReason = keyof typeof TEXT_SKIP_REASONS;
