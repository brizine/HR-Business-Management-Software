import crypto from "node:crypto";
import { toE164 } from "@crewdesk/shared";
import type { Inbound, TextingProvider } from "./texting";

/**
 * Talkroute's API (v2): the account, the numbers that can text, sending a text into a conversation,
 * reading conversations (to catch up on anything missed), and "tell me about new texts" webhooks.
 * Reference: apidocs.talkroute.com. Sending needs Talkroute's bulk texting plan; without it the
 * API answers 402.
 */

const base = () => (process.env.TALKROUTE_API_URL ?? "https://api.talkroute.com/api").replace(/\/$/, "");
/** Talkroute writes numbers as digits with the country's 1 in front ("14055550100"). */
const digits = (e164: string) => e164.replace(/\D/g, "");

/** What Talkroute said no to, with its HTTP status (402: not in the plan; 429: too fast). */
export class TalkrouteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function tr<T = any>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TalkrouteError(0, "Talkroute couldn't be reached. Try again in a minute.");
  }
  if (res.status === 204) return null as T;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: an error page */ }
  if (res.ok) return json as T;
  const errors = Array.isArray(json?.errors) ? json.errors : json?.errors && typeof json.errors === "object" ? Object.values(json.errors).flat() : [];
  const said = [json?.message, ...errors].filter((x): x is string => typeof x === "string").join(" ").slice(0, 300);
  throw new TalkrouteError(res.status,
    res.status === 401 ? "Talkroute didn't accept that API key"
    : res.status === 402 ? "Talkroute says this account's plan doesn't include that. Sending texts through their API needs Talkroute's bulk texting plan; ask Talkroute to add it."
    : res.status === 403 ? `Talkroute says this API key's user isn't allowed to do that${said ? ` (${said})` : ""}`
    : res.status === 429 ? "Talkroute says too many texts are going out right now. Try again in a minute."
    : said || `Talkroute answered ${res.status}`);
}

/** Every page of a list (Talkroute pages its lists), up to `maxPages`. */
async function pages<T>(key: string, path: string, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await tr<{ data: T[]; pagination?: { currentPage?: number; totalPages?: number } }>(key, "GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=50`);
    out.push(...(r?.data ?? []));
    if (!r?.data?.length || !r.pagination || (r.pagination.currentPage ?? page) >= (r.pagination.totalPages ?? 1)) break;
  }
  return out;
}

type TrNumber = { phoneNumber: string; description?: string | null; textMessagingAllowed?: boolean; hasActiveCampaign?: boolean; messagingActivated?: boolean; messagingStatus?: boolean; couldBeUsedForMessaging?: boolean };
type TrMessage = { id: string; body?: string | null; created_at?: string; created_at_micro_seconds?: number; message_direction?: "incoming" | "outgoing"; talkroute_number?: string; contact_number?: string; attachments?: unknown[] };

/** A text with nothing typed is a picture (or other attachment); Crewdesk shows this in its place. */
export const PICTURE_NOTE = "[Picture or attachment. Open Talkroute to see it.]";

export const talkroute: TextingProvider = {
  ready: true,

  async numbers(key) {
    const rows = await pages<TrNumber>(key, "/v2/virtual-numbers?couldBeUsedForMessaging=1");
    return rows.map((n) => ({
      number: toE164(n.phoneNumber) ?? n.phoneNumber,
      label: n.description?.trim() || null,
      // Texting has to be switched on for the number, and this key's user allowed to text from it.
      canSend: n.textMessagingAllowed !== false && (n.messagingActivated ?? n.messagingStatus ?? true) !== false,
      registered: n.hasActiveCampaign ?? null,
    }));
  },

  async check(c) {
    const account = await tr<{ data: { name?: string | null } }>(c.key, "GET", "/v2/account");
    const mine = await this.numbers!(c.key);
    const n = mine.find((x) => x.number === c.fromNumber);
    if (!n) throw new TalkrouteError(422, mine.length ? "That isn't one of your Talkroute numbers that can text. Pick one from the list." : "This Talkroute account has no number that can text yet.");
    return { accountName: account?.data?.name ?? null };
  },

  async send(c, to, body) {
    const r = await tr<{ data: TrMessage }>(c.key, "POST", `/v2/text-conversations/${digits(c.fromNumber)}-${digits(to)}`, { body });
    return { id: r.data.id, status: "sent" };
  },

  /** Texts since `since` on the company's number, both ways, oldest first (the catch-up for anything a webhook missed). */
  async inbound(c, since) {
    const convs = await pages<{ conversation_id: string; contact_number: string }>(c.key, `/v2/text-conversations?since=${encodeURIComponent(since.toISOString())}&talkrouteNumber=${digits(c.fromNumber)}`, 4);
    const out: Inbound[] = [];
    for (const conv of convs.slice(0, 100)) {
      const msgs = await pages<TrMessage>(c.key, `/v2/text-conversations/${conv.conversation_id}/messages`, 1);
      for (const m of msgs) {
        const at = m.created_at_micro_seconds ? new Date(m.created_at_micro_seconds * 1000) : new Date(m.created_at ?? Date.now());
        if (!(at > since)) continue;
        const contact = toE164(m.contact_number ?? conv.contact_number) ?? (m.contact_number ?? conv.contact_number);
        out.push({ id: m.id, from: contact, body: m.body?.trim() || (m.attachments?.length ? PICTURE_NOTE : ""), at, direction: m.message_direction === "outgoing" ? "out" : "in" });
      }
    }
    return out.filter((m) => m.body).sort((a, b) => +a.at - +b.at);
  },

  async subscribe(c, url) {
    // One subscription for this address: an earlier one (a reconnect) is replaced.
    const old = await pages<{ id: string; hookUrl: string; type: string }>(c.key, "/v2/subscriptions", 3).catch(() => []);
    for (const s of old) if (s.hookUrl === url && s.type === "new_text_message") await tr(c.key, "DELETE", `/v2/subscriptions/${s.id}`).catch(() => {});
    const r = await tr<{ data: { id: string; signingSecret: string } }>(c.key, "POST", "/v2/subscriptions", { hookUrl: url, type: "new_text_message" });
    return { id: r.data.id, secret: r.data.signingSecret };
  },

  async unsubscribe(c, id) {
    await tr(c.key, "DELETE", `/v2/subscriptions/${id}`).catch((e) => { if (!(e instanceof TalkrouteError && e.status === 404)) throw e; });
  },

  /** Talkroute signs each call the Standard Webhooks way: HMAC-SHA256 of "id.timestamp.body" with the subscription's secret. */
  verify(secret, headers, raw) {
    const id = String(headers["webhook-id"] ?? ""), timestamp = String(headers["webhook-timestamp"] ?? ""), signatures = String(headers["webhook-signature"] ?? "");
    if (!id || !timestamp || !signatures) return false;
    // Old or future-dated calls are refused, so a captured one can't be replayed later.
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const expected = crypto.createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.`).update(raw).digest();
    return signatures.split(" ").some((versioned) => {
      const [version, signature] = versioned.split(",");
      const got = Buffer.from(signature ?? "", "base64");
      return version === "v1" && got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
  },

  parseHook(raw) {
    let j: { event_id?: string; datetime?: string; direction?: string; from_number?: string; to_number?: string; body?: string };
    try { j = JSON.parse(raw.toString("utf8")); } catch { return null; }
    if (!j?.event_id || !j.from_number || !j.to_number) return null;
    const out = j.direction === "outgoing";
    const at = j.datetime ? new Date(j.datetime) : new Date();
    return { id: `evt:${j.event_id}`, from: out ? j.to_number : j.from_number, ours: out ? j.from_number : j.to_number, body: j.body?.trim() || PICTURE_NOTE, at: Number.isNaN(+at) ? new Date() : at, direction: out ? "out" : "in" };
  },
};
