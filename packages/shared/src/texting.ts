import { z } from "zod";

/** Texting customers from the company's own number: what can be sent, and how replies are read. */

export const TEXT_MAX = 1000;
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
