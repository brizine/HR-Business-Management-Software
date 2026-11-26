import crypto from "node:crypto";
import { toE164 } from "@crewdesk/shared";
import type { CallEvent, Inbound, MediaRef, TextingProvider } from "./texting";

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
type TrAttachment = { id: string; file_type?: string | null; content_type?: string | null; link?: string | null };
type TrMessage = { id: string; body?: string | null; created_at?: string; created_at_micro_seconds?: number; message_direction?: "incoming" | "outgoing"; talkroute_number?: string; contact_number?: string; attachments?: TrAttachment[] };
const sentAt = (m: TrMessage) => (m.created_at_micro_seconds ? new Date(m.created_at_micro_seconds * 1000) : new Date(m.created_at ?? Date.now()));
const mediaOf = (m: TrMessage): MediaRef[] => (m.attachments ?? []).filter((a) => a?.link).map((a) => ({ id: a.id, contentType: a.content_type ?? (a.file_type === "image" ? "image/jpeg" : null), link: a.link! }));
const asInbound = (m: TrMessage, contact: string): Inbound => ({
  id: m.id, from: toE164(m.contact_number ?? contact) ?? (m.contact_number ?? contact), body: m.body?.trim() || (m.attachments?.length ? PICTURE_NOTE : ""), at: sentAt(m),
  direction: m.message_direction === "outgoing" ? "out" : "in", media: mediaOf(m),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause between requests on the long jobs, to stay well under Talkroute's 120 a minute. Tests set it to 0. */
export const TALKROUTE_PACE = { ms: Number(process.env.TALKROUTE_PACE_MS ?? 700) };

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

  async send(c, to, body, picture) {
    // A picture rides along as a data: address, with its MD5 so Talkroute can tell it arrived whole.
    const attachment = picture ? { fileType: picture.contentType, content: `data:${picture.contentType};base64,${picture.data.toString("base64")}`, hash: crypto.createHash("md5").update(picture.data).digest("hex") } : undefined;
    const r = await tr<{ data: TrMessage }>(c.key, "POST", `/v2/text-conversations/${digits(c.fromNumber)}-${digits(to)}`, { body, ...(attachment ? { attachment } : {}) });
    return { id: r.data.id, status: "sent" };
  },

  /** The text a webhook was about, as Talkroute lists it: its own id and any pictures on it (the webhook carries neither). */
  async findMessage(c, contact, hint) {
    const msgs = await pages<TrMessage>(c.key, `/v2/text-conversations/${digits(c.fromNumber)}-${digits(contact)}/messages`, 1);
    const want = hint.direction === "out" ? "outgoing" : "incoming";
    const near = msgs.filter((m) => (m.message_direction ?? "incoming") === want && Math.abs(+sentAt(m) - +hint.at) < 180_000 && ((m.body?.trim() ?? "") === hint.body || (!m.body?.trim() && hint.body === PICTURE_NOTE)))
      .sort((a, b) => Math.abs(+sentAt(a) - +hint.at) - Math.abs(+sentAt(b) - +hint.at));
    return near[0] ? { id: near[0].id, media: mediaOf(near[0]) } : null;
  },

  /** A picture's bytes, from the short-lived address Talkroute gives for it. */
  async download(ref) {
    const res = await fetch(ref.link, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new TalkrouteError(res.status, "The picture couldn't be fetched from Talkroute");
    const data = Buffer.from(await res.arrayBuffer());
    return { data, contentType: ref.contentType ?? res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
  },

  /** Texts since `since` on the company's number, both ways, oldest first (the catch-up for anything a webhook missed). */
  async inbound(c, since) {
    const convs = await pages<{ conversation_id: string; contact_number: string }>(c.key, `/v2/text-conversations?since=${encodeURIComponent(since.toISOString())}&talkrouteNumber=${digits(c.fromNumber)}`, 4);
    const out: Inbound[] = [];
    for (const conv of convs.slice(0, 100)) {
      const msgs = await pages<TrMessage>(c.key, `/v2/text-conversations/${conv.conversation_id}/messages`, 1);
      for (const m of msgs) if (sentAt(m) > since) out.push(asInbound(m, conv.contact_number));
    }
    return out.filter((m) => m.body).sort((a, b) => +a.at - +b.at);
  },

  /** Every conversation with a text since `since`, a conversation at a time (oldest text first), paced so a long history doesn't trip Talkroute's limit. */
  async history(c, since, each, progress) {
    const convs = await pages<{ conversation_id: string; contact_number: string }>(c.key, `/v2/text-conversations?since=${encodeURIComponent(since.toISOString())}&talkrouteNumber=${digits(c.fromNumber)}`, 40);
    let done = 0;
    await progress(0, convs.length);
    for (const conv of convs) {
      const msgs = await pages<TrMessage>(c.key, `/v2/text-conversations/${conv.conversation_id}/messages`, 6);
      const mine = msgs.filter((m) => sentAt(m) > since).map((m) => asInbound(m, conv.contact_number)).filter((m) => m.body).sort((a, b) => +a.at - +b.at);
      for (const m of mine) await each(m);
      await progress(++done, convs.length);
      if (TALKROUTE_PACE.ms) await sleep(TALKROUTE_PACE.ms);
    }
  },

  /** Adds people to the account's contacts, so names show in Talkroute's apps. Ones already there (by their Crewdesk id) are left as they are. */
  async addContacts(c, people) {
    const r = await tr<{ data: { contactsImported?: number; contactsSkipped?: number } }>(c.key, "POST", "/v2/contacts/import", {
      contacts: people.map((p) => ({ externalId: p.id, name: p.name.slice(0, 100), phones: p.phones.map((n, i) => ({ phoneNumber: n, type: i === 0 ? "Mobile" : "Other" })), ...(p.email ? { emails: [p.email] } : {}), ...(p.company ? { company: p.company.slice(0, 100) } : {}), ...(p.notes ? { notes: p.notes } : {}) })),
    });
    return { added: r?.data?.contactsImported ?? 0, skipped: r?.data?.contactsSkipped ?? 0 };
  },

  /** Where a voicemail's recording can be played from (a short-lived address), found by who left it and when. */
  async voicemailAudio(c, hint) {
    const list = await pages<{ id: string; callerNumber?: string; createdAt?: string }>(c.key, "/v2/voice-messages", 4);
    const match = list.filter((v) => (toE164(v.callerNumber) ?? v.callerNumber) === hint.from && v.createdAt && Math.abs(+new Date(v.createdAt) - +hint.at) < 300_000)
      .sort((a, b) => Math.abs(+new Date(a.createdAt!) - +hint.at) - Math.abs(+new Date(b.createdAt!) - +hint.at))[0];
    if (!match) return null;
    const r = await tr<{ url?: string; data?: { url?: string } }>(c.key, "GET", `/v2/voice-messages/${match.id}/audio-url`);
    return r?.url ?? r?.data?.url ?? null;
  },

  async subscribe(c, url, kind = "text") {
    const type = kind === "call" ? "new_call_record" : kind === "voicemail" ? "new_voicemail" : "new_text_message";
    // One subscription for this address: an earlier one (a reconnect) is replaced.
    const old = await pages<{ id: string; hookUrl: string; type: string }>(c.key, "/v2/subscriptions", 3).catch(() => []);
    for (const s of old) if (s.hookUrl === url && s.type === type) await tr(c.key, "DELETE", `/v2/subscriptions/${s.id}`).catch(() => {});
    const r = await tr<{ data: { id: string; signingSecret: string } }>(c.key, "POST", "/v2/subscriptions", { hookUrl: url, type });
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

  /** A call or a voicemail, as Talkroute reports it. */
  parseCall(raw, kind) {
    let j: { event_id?: string; datetime?: string; call_result?: string; direction?: string; duration?: number; caller_number?: string; called_number?: string; caller_cname?: string; transcription?: string };
    try { j = JSON.parse(raw.toString("utf8")); } catch { return null; }
    if (!j?.event_id || !j.caller_number || !j.called_number) return null;
    const at = j.datetime ? new Date(j.datetime) : new Date();
    const result = j.call_result === "missed" || j.call_result === "hangup" ? j.call_result : "answered";
    const event: CallEvent & { ours: string } = {
      id: `evt:${j.event_id}`, kind, phone: j.caller_number, ours: j.called_number, direction: kind === "voicemail" || j.direction !== "outbound" ? "in" : "out", result,
      durationSeconds: Math.max(0, Math.round(Number(j.duration) || 0)), callerName: j.caller_cname?.trim() || null, transcript: j.transcription?.trim() || null, at: Number.isNaN(+at) ? new Date() : at,
    };
    return event;
  },
};
