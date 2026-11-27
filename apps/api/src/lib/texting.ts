import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { INACTIVE_STATUSES, customerName, formatPhone, inQuietHours, officeOpen, textKeyword, textingChoices, toE164, type TextingJob, type TextingOptions } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customerFiles, customerTexts, customers, employees, phoneCalls, propertyContacts, textBatches, textMedia, textThreads, todoAssignees, todos } from "../db/schema";
import { isManager } from "./auth";
import { PUBLIC_API_URL } from "./channels";
import { decrypt, encrypt } from "./crypto";
import { HttpError } from "./errors";
import { notify, staffWithRole } from "./notify";
import { storage } from "./storage";
import { PICTURE_NOTE, talkroute } from "./talkroute";
import { fillTemplateText, templateVars } from "./templates";
import { localDate } from "./tz";

/**
 * Texting from the company's own number. A provider (Talkroute) sends the texts and tells
 * Crewdesk about the ones that come in; Crewdesk keeps each conversation (one per phone number,
 * filed under the customer or employee whose number it is), honors STOP and START, and tells
 * the people the company picked about every text that arrives.
 */

const PURPOSE = "texting";
const HOOK_PURPOSE = "texting-hook";
type Config = { key: string; fromNumber: string };
/** A picture on a text, as the provider points to it (the address is short-lived). */
export type MediaRef = { id: string; contentType: string | null; link: string };
/** A picture to send, or one fetched. */
export type Picture = { contentType: string; data: Buffer; fileName?: string };
/** A text the provider reports. "out": sent from the provider's own app rather than Crewdesk. */
export type Inbound = { id: string; from: string; body: string; at: Date; direction?: "in" | "out"; media?: MediaRef[] };
/** A call or voicemail the provider reports. */
export type CallEvent = { id: string; kind: "call" | "voicemail"; phone: string; direction: "in" | "out"; result: "answered" | "missed" | "hangup"; durationSeconds: number; callerName: string | null; transcript: string | null; at: Date };
export type HookKind = "text" | "call" | "voicemail";
export type TextNumber = { number: string; label: string | null; canSend: boolean; registered?: boolean | null };

export interface TextingProvider {
  /** Whether this provider can be connected yet. */
  ready: boolean;
  /** Checks the key and number with the provider (throws with a clear message if they're wrong). */
  check(c: Config): Promise<{ accountName?: string | null }>;
  /** The account's numbers that can text, to pick the one Crewdesk uses. */
  numbers?(key: string): Promise<TextNumber[]>;
  send(c: Config, to: string, body: string, picture?: Picture): Promise<{ id: string; status?: "sent" | "delivered" }>;
  /** The text a webhook was about, as the provider lists it: its real id and any pictures. */
  findMessage?(c: Config, contact: string, hint: { direction: "in" | "out"; body: string; at: Date }): Promise<{ id: string; media: MediaRef[] } | null>;
  download?(ref: MediaRef): Promise<Picture>;
  /** Past conversations since `since`, a conversation at a time. */
  history?(c: Config, since: Date, each: (m: Inbound) => Promise<void>, progress: (done: number, total: number) => Promise<void>): Promise<void>;
  /** Adds people to the provider's contacts (ones already there are skipped). */
  addContacts?(c: Config, people: { id: string; name: string; phones: string[]; email?: string | null; company?: string | null; notes?: string | null }[]): Promise<{ added: number; skipped: number }>;
  voicemailAudio?(c: Config, hint: { from: string; at: Date }): Promise<string | null>;
  parseCall?(raw: Buffer, kind: "call" | "voicemail"): (CallEvent & { ours: string }) | null;
  /** Texts since `since`, oldest first (asked for now and then, to catch anything a webhook missed). */
  inbound?(c: Config, since: Date): Promise<Inbound[]>;
  /** Asks the provider to call `url` about each new text; what comes back verifies its calls and takes it off again. */
  subscribe?(c: Config, url: string, kind?: HookKind): Promise<{ id: string; secret: string }>;
  unsubscribe?(c: Config, id: string): Promise<void>;
  verify?(secret: string, headers: Record<string, unknown>, raw: Buffer): boolean;
  parseHook?(raw: Buffer): (Inbound & { ours: string }) | null;
}

let provider: TextingProvider = talkroute;
/** Tests swap in a pretend provider. */
export function setTextingProvider(p: TextingProvider | null) { provider = p ?? talkroute; }
export const textingProvider = () => provider;

type Stored = NonNullable<(typeof companies.$inferSelect)["texting"]>;
export async function textingConfig(companyId: string): Promise<(Config & Omit<Stored, "provider" | "fromNumber"> & { accountName: string | null; inboundSince: string | null; webhook: boolean; calls: boolean }) | null> {
  const [c] = await db.select({ t: companies.texting, k: companies.textingKey, s: companies.textingHookSecret }).from(companies).where(eq(companies.id, companyId));
  if (!c?.t || !c.k) return null;
  return {
    ...c.t, key: decrypt(c.k, PURPOSE), fromNumber: c.t.fromNumber, accountName: c.t.accountName ?? null, inboundSince: c.t.inboundSince ?? null,
    webhook: !!(c.t.subscriptionId && c.s), calls: !!(c.t.callSubscriptionId && c.s),
  };
}

/** Each webhook's signing secret, kept together (encrypted). An older connection kept only the one for texts. */
function hookSecrets(stored: string | null): Partial<Record<HookKind, string>> {
  if (!stored) return {};
  const plain = decrypt(stored, HOOK_PURPOSE);
  if (plain.startsWith("whsec_")) return { text: plain };
  try { return JSON.parse(plain) as Partial<Record<HookKind, string>>; } catch { return {}; }
}
const hookUrl = (token: string, kind: HookKind) => `${PUBLIC_API_URL}/texting/hooks/talkroute/${token}${kind === "text" ? "" : `/${kind}`}`;

const said = (e: unknown, fallback: string) => (e instanceof HttpError ? e : new HttpError(400, (e as Error).message || fallback));

/** The numbers on a provider account that can text (before connecting: to pick one). */
export async function textingNumbers(apiKey: string): Promise<TextNumber[]> {
  if (!provider.numbers) return [];
  return provider.numbers(apiKey).catch((e) => { throw said(e, "Talkroute didn't accept those details"); });
}

/**
 * Connects texting: checks the key and number, then asks the provider to tell Crewdesk about new
 * texts. If that last part can't be set up, texting still connects and Crewdesk asks for new
 * texts every few minutes instead.
 */
export async function connectTexting(companyId: string, apiKey: string, fromNumber: string): Promise<{ webhook: boolean; webhookError?: string }> {
  const from = toE164(fromNumber);
  if (!from) throw new HttpError(400, "Enter your Talkroute number, with its area code");
  const cfg = { key: apiKey, fromNumber: from };
  const { accountName } = await provider.check(cfg).catch((e) => { throw said(e, "Talkroute didn't accept those details"); });
  // A connection being replaced: take its webhooks off first.
  await dropHooks(companyId);
  const token = crypto.randomBytes(24).toString("hex");
  const subs: Partial<Record<HookKind, { id: string; secret: string }>> = {};
  let webhookError: string | undefined;
  if (provider.subscribe) {
    try { subs.text = await provider.subscribe(cfg, hookUrl(token, "text"), "text"); } catch (e) { webhookError = (e as Error).message; }
    // Calls and voicemails (for the customer's page and the missed-call text): nice to have, so a refusal doesn't stop texting.
    if (subs.text) for (const kind of ["call", "voicemail"] as const) { try { subs[kind] = await provider.subscribe(cfg, hookUrl(token, kind), kind); } catch { /* left off */ } }
  }
  const now = new Date().toISOString();
  const secrets = Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, v!.secret]));
  await db.update(companies).set({
    texting: {
      provider: "talkroute", fromNumber: from, connectedAt: now, accountName: accountName ?? null, inboundSince: now, hookAt: null, polledAt: null,
      subscriptionId: subs.text?.id ?? null, callSubscriptionId: subs.call?.id ?? null, voicemailSubscriptionId: subs.voicemail?.id ?? null,
    },
    textingKey: encrypt(apiKey, PURPOSE),
    textingHookSecret: subs.text ? encrypt(JSON.stringify(secrets), HOOK_PURPOSE) : null,
    textingHookToken: subs.text ? token : null,
  }).where(eq(companies.id, companyId));
  return { webhook: !!subs.text, webhookError };
}

async function dropHooks(companyId: string) {
  const cfg = await textingConfig(companyId).catch(() => null);
  if (!cfg || !provider.unsubscribe) return;
  for (const id of [cfg.subscriptionId, cfg.callSubscriptionId, cfg.voicemailSubscriptionId]) if (id) await provider.unsubscribe(cfg, id).catch(() => {});
}

export async function disconnectTexting(companyId: string) {
  await dropHooks(companyId);
  await db.update(companies).set({ texting: null, textingKey: null, textingHookSecret: null, textingHookToken: null }).where(eq(companies.id, companyId));
}

/* ───────────── Who may text, and who hears about texts ───────────── */

/** The people picked to hear about incoming texts (still on the team). Nobody picked: Customers & billing managers. */
export async function textTeam(companyId: string): Promise<{ picked: boolean; ids: string[] }> {
  const [c] = await db.select({ ids: companies.textingNotifyIds }).from(companies).where(eq(companies.id, companyId));
  const picked = c?.ids ?? [];
  if (picked.length) {
    const rows = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, picked), notInArray(employees.status, INACTIVE_STATUSES)));
    if (rows.length) return { picked: true, ids: rows.map((r) => r.id) };
  }
  return { picked: false, ids: await staffWithRole(companyId, "manager", "customers") };
}

/** Texting is for Customers & billing managers and anyone picked to hear about incoming texts. */
export async function hasTextingAccess(req: FastifyRequest) {
  if (isManager(req, "customers")) return true;
  const [c] = await db.select({ ids: companies.textingNotifyIds }).from(companies).where(eq(companies.id, req.user.companyId));
  return !!c?.ids?.includes(req.user.sub);
}
export async function requireTexting(req: FastifyRequest) {
  if (!(await hasTextingAccess(req))) throw new HttpError(403, "Texting is for Customers & billing managers and the people picked to answer texts");
}

/* ───────────── Conversations ───────────── */

/** The number to text a customer at: their phone, else their other phone (US numbers). */
export const textNumberFor = (c: { phone: string | null; altPhone: string | null }) => toE164(c.phone) ?? toE164(c.altPhone);

type Row = typeof customerTexts.$inferSelect;
export type Thread = typeof textThreads.$inferSelect;
const digits10 = (col: unknown) => sql`right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;

/** Whose number this is: a customer's (their phone or other phone, then a contact's), else someone on the team's. */
export async function whoHasNumber(companyId: string, e164: string): Promise<{ customerId: string | null; employeeId: string | null }> {
  const ten = e164.replace(/\D/g, "").slice(-10);
  if (ten.length < 10) return { customerId: null, employeeId: null };
  const [c] = await db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.companyId, companyId), or(sql`${digits10(customers.phone)} = ${ten}`, sql`${digits10(customers.altPhone)} = ${ten}`)))
    .orderBy(sql`${customers.status} = 'active' desc`, desc(customers.createdAt)).limit(1);
  if (c) return { customerId: c.id, employeeId: null };
  const [k] = await db.select({ id: customerContacts.customerId }).from(customerContacts).innerJoin(customers, eq(customers.id, customerContacts.customerId))
    .where(and(eq(customers.companyId, companyId), sql`${digits10(customerContacts.phone)} = ${ten}`)).limit(1);
  if (k) return { customerId: k.id, employeeId: null };
  const [e] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.companyId, companyId), sql`${digits10(employees.phone)} = ${ten}`, notInArray(employees.status, INACTIVE_STATUSES))).limit(1);
  return { customerId: null, employeeId: e?.id ?? null };
}

/** The conversation with a number, made the first time it's needed; `who` files it under a customer or employee. */
export async function threadFor(companyId: string, phone: string, who?: { customerId?: string | null; employeeId?: string | null }): Promise<Thread> {
  const find = async () => (await db.select().from(textThreads).where(and(eq(textThreads.companyId, companyId), eq(textThreads.phone, phone))))[0];
  let t = await find();
  if (!t) {
    const w = who?.customerId || who?.employeeId ? who : await whoHasNumber(companyId, phone);
    await db.insert(textThreads).values({ companyId, phone, customerId: w.customerId ?? null, employeeId: w.customerId ? null : w.employeeId ?? null }).onConflictDoNothing();
    t = await find();
  } else if (!t.customerId && !t.employeeId && (who?.customerId || who?.employeeId)) {
    [t] = await db.update(textThreads).set({ customerId: who.customerId ?? null, employeeId: who.customerId ? null : who.employeeId ?? null }).where(eq(textThreads.id, t.id)).returning();
  }
  return t!;
}

/** Saves a text in its conversation and brings the conversation's "latest" up to date. Null if it was already saved. */
async function addText(thread: Thread, v: Omit<typeof customerTexts.$inferInsert, "companyId" | "threadId" | "phone">): Promise<Row | null> {
  const [row] = await db.insert(customerTexts).values({ ...v, companyId: thread.companyId, threadId: thread.id, phone: thread.phone, customerId: v.customerId ?? thread.customerId, employeeId: v.employeeId ?? thread.employeeId })
    .onConflictDoNothing().returning();
  if (!row) return null;
  if (row.source !== "test" && row.status !== "queued" && row.status !== "scheduled" && row.direction !== "note") await touchThread(row, !!v.readAt);
  return row;
}

/** What the conversation list shows for a text: its words, or that it's a picture. */
const preview = (body: string) => (body && body !== PICTURE_NOTE ? body.slice(0, 300) : "📷 Picture");

async function touchThread(row: Row, alreadyRead = false) {
  if (!row.threadId) return;
  // The list shows the newest text (one brought in late doesn't push a newer one aside).
  await db.update(textThreads).set({ lastAt: row.createdAt, lastBody: preview(row.body), lastDirection: row.direction, lastStatus: row.status })
    .where(and(eq(textThreads.id, row.threadId), sql`(${textThreads.lastAt} <= ${row.createdAt.toISOString()}::timestamptz or ${textThreads.lastBody} = '')`));
  // A reply counts as unread until someone opens it, and opens a conversation marked done again.
  if (row.direction === "in" && !alreadyRead) await db.update(textThreads).set({ unread: sql`${textThreads.unread} + 1`, status: "open" }).where(eq(textThreads.id, row.threadId));
}

/* ───────────── Pictures ───────────── */

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "video/mp4": "mp4", "application/pdf": "pdf" };

/** Keeps a text's pictures (encrypted, like other uploads). One a customer sent is also put with their photos and documents. */
async function saveMedia(row: Row, files: Picture[]) {
  let n = 0;
  for (const f of files.slice(0, 6)) {
    if (!f.data.length || f.data.length > 20_000_000) continue;
    const fileName = (f.fileName || `text-${row.createdAt.toISOString().slice(0, 10)}-${n + 1}.${EXT[f.contentType] ?? "bin"}`).replace(/[^\w.\- ]/g, "_").slice(0, 120);
    const storageKey = `${row.companyId}/texts/${row.threadId ?? row.id}/${crypto.randomUUID()}-${fileName.replace(/\s+/g, "_")}`;
    await storage.put(storageKey, f.data);
    await db.insert(textMedia).values({ companyId: row.companyId, textId: row.id, fileName, contentType: f.contentType, sizeBytes: f.data.length, storageKey });
    if (row.direction === "in" && row.customerId) await fileUnderCustomer(row.companyId, row.customerId, { fileName, contentType: f.contentType, data: f.data }, row.createdAt);
    n++;
  }
  return n;
}

async function fileUnderCustomer(companyId: string, customerId: string, f: Required<Picture>, at: Date) {
  const storageKey = `${companyId}/customers/${customerId}/${crypto.randomUUID()}-${f.fileName.replace(/\s+/g, "_")}`;
  await storage.put(storageKey, f.data);
  await db.insert(customerFiles).values({ companyId, customerId, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.data.length, storageKey, caption: `Texted to us ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` });
}

/** Fetches a text's pictures from the provider and keeps them. A text that was only a picture loses its stand-in words. */
async function pullMedia(row: Row, refs: MediaRef[]) {
  if (!refs.length || !provider.download) return 0;
  const files: Picture[] = [];
  for (const ref of refs.slice(0, 6)) { try { files.push(await provider.download(ref)); } catch (e) { console.error("A text's picture couldn't be fetched:", (e as Error).message); } }
  const n = await saveMedia(row, files);
  if (n && row.body === PICTURE_NOTE) await db.update(customerTexts).set({ body: "" }).where(eq(customerTexts.id, row.id));
  return n;
}

/**
 * After a webhook: asks the provider for the text itself, to learn its real id (so a later
 * catch-up knows it's the same one) and to fetch any pictures (a webhook carries neither).
 */
async function enrich(cfg: Config, row: Row, m: Inbound) {
  if (!provider.findMessage) return;
  try {
    const found = await provider.findMessage(cfg, row.phone, { direction: row.direction === "out" ? "out" : "in", body: m.body, at: m.at });
    if (!found) return;
    await db.update(customerTexts).set({ providerId: found.id }).where(eq(customerTexts.id, row.id)).catch(() => { /* already here under that id */ });
    await pullMedia(row, found.media);
  } catch (e) { console.error("Looking up a text's pictures failed:", (e as Error).message); }
}
/** Lookups still going (tests wait for them). */
const enriching = new Set<Promise<void>>();
export async function flushTextLookups() { while (enriching.size) await Promise.all([...enriching]); }

/** A text's pictures, for showing it. */
export async function mediaFor(textIds: string[]) {
  const rows = textIds.length ? await db.select({ id: textMedia.id, textId: textMedia.textId, fileName: textMedia.fileName, contentType: textMedia.contentType }).from(textMedia).where(inArray(textMedia.textId, textIds)).orderBy(asc(textMedia.createdAt)) : [];
  const by = new Map<string, { id: string; fileName: string; contentType: string }[]>();
  for (const r of rows) by.set(r.textId, [...(by.get(r.textId) ?? []), { id: r.id, fileName: r.fileName, contentType: r.contentType }]);
  return by;
}

/** Hands a saved text to the provider and records how it went. */
async function deliver(cfg: Config, row: Row, picture?: Picture): Promise<Row> {
  try {
    const r = await provider.send(cfg, row.phone, row.body, picture);
    const [u] = await db.update(customerTexts).set({ status: r.status ?? "sent", providerId: r.id, error: null }).where(eq(customerTexts.id, row.id)).returning();
    if (u.threadId) await db.update(textThreads).set({ lastStatus: u.status }).where(and(eq(textThreads.id, u.threadId), eq(textThreads.lastAt, u.createdAt)));
    return u;
  } catch (e) {
    const [u] = await db.update(customerTexts).set({ status: "failed", error: (e as Error).message.slice(0, 500) }).where(eq(customerTexts.id, row.id)).returning();
    if (u.threadId) await db.update(textThreads).set({ lastStatus: "failed" }).where(and(eq(textThreads.id, u.threadId), eq(textThreads.lastAt, u.createdAt)));
    return Object.assign(u, { providerStatus: (e as { status?: number }).status });
  }
}

const NOT_CONNECTED = "Texting isn't connected (Settings → Integrations)";

/**
 * Texts a customer. Skips (with a reason) when texting isn't connected, they have no number, or
 * they replied STOP. The text is saved either way it goes, so it shows on their page.
 */
export async function sendCustomerText(companyId: string, customerId: string, body: string, o: { by: string | null; source: "office" | "automation" }): Promise<{ text: Row | null; skipped?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { text: null, skipped: NOT_CONNECTED };
  const [cust] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!cust) throw new HttpError(404, "Customer not found");
  if (cust.textOptOutAt) return { text: null, skipped: `${customerName(cust)} replied STOP, so they can't be texted until they reply START` };
  const to = textNumberFor(cust);
  if (!to) return { text: null, skipped: `${customerName(cust)} has no mobile number on file` };
  const thread = await threadFor(companyId, to, { customerId });
  const row = await addText(thread, { customerId, direction: "out", body, status: "sending", source: o.source, sentById: o.by });
  return { text: await deliver(cfg, row!) };
}

/** A reply typed into a conversation: goes to that conversation's number, whoever's it is. */
export async function sendThreadText(companyId: string, threadId: string, body: string, o: { by: string | null; picture?: Picture; source?: "office" | "auto"; sendAt?: Date | null }): Promise<{ text: Row | null; skipped?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { text: null, skipped: NOT_CONNECTED };
  const [thread] = await db.select().from(textThreads).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
  if (!thread) throw new HttpError(404, "Conversation not found");
  const [cust] = thread.customerId ? await db.select().from(customers).where(eq(customers.id, thread.customerId)) : [];
  if (cust?.textOptOutAt) return { text: null, skipped: `${customerName(cust)} replied STOP, so they can't be texted until they reply START` };
  // Written to go later: it waits, and the scheduler sends it when its time comes.
  if (o.sendAt) return { text: await addText(thread, { direction: "out", body, status: "scheduled", sendAt: o.sendAt, source: "office", sentById: o.by }) };
  const row = await addText(thread, { direction: "out", body, status: "sending", source: o.source ?? "office", sentById: o.by });
  if (o.picture) await saveMedia(row!, [o.picture]);
  return { text: await deliver(cfg, row!, o.picture) };
}

/** The office's own note in a conversation ("called her back, she'll think about it"): never sent. */
export async function addTextNote(companyId: string, threadId: string, body: string, by: string) {
  const [thread] = await db.select().from(textThreads).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
  if (!thread) throw new HttpError(404, "Conversation not found");
  return (await addText(thread, { direction: "note", body, status: "note", source: "office", sentById: by }))!;
}

/**
 * Makes a conversation one person's to answer (or nobody's again). From then on only they are
 * told about its texts, and they're told it's theirs.
 */
export async function assignThread(companyId: string, threadId: string, employeeId: string | null, by: string) {
  const [thread] = await db.select().from(textThreads).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
  if (!thread) throw new HttpError(404, "Conversation not found");
  if (employeeId) {
    const allowed = await textPeople(companyId);
    if (!allowed.some((p) => p.id === employeeId)) throw new HttpError(400, "Pick someone who answers texts (a Customers & billing manager, or a person ticked under Settings → Integrations)");
  }
  await db.update(textThreads).set({ assignedId: employeeId }).where(eq(textThreads.id, thread.id));
  if (employeeId && employeeId !== by) {
    const [giver] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, by));
    notify(companyId, [employeeId], { category: "texts", title: `${giver ? `${giver.f} ${giver.l}` : "Someone"} gave you a text conversation`, body: `With ${await threadName(thread)}. You'll be told about its texts from here on.`, link: { screen: "texts", threadId: thread.id } });
  }
}

/** Everyone who can answer texts: Customers & billing managers, and the people picked to be told. */
export async function textPeople(companyId: string) {
  const [c] = await db.select({ ids: companies.textingNotifyIds }).from(companies).where(eq(companies.id, companyId));
  const ids = [...new Set([...(c?.ids ?? []), ...(await staffWithRole(companyId, "manager", "customers"))])];
  if (!ids.length) return [];
  const rows = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, textQuiet: employees.textQuiet }).from(employees)
    .where(and(eq(employees.companyId, companyId), inArray(employees.id, ids), notInArray(employees.status, INACTIVE_STATUSES))).orderBy(asc(employees.firstName), asc(employees.lastName));
  return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`, textQuiet: r.textQuiet }));
}

/**
 * Texts the owner or an employee from the company's number (automations, and Send Text Messages).
 * Kept as a conversation with that number, so a reply has somewhere to land.
 */
export async function sendStaffText(companyId: string, phone: string | null, body: string, o: { by?: string | null; employeeId?: string | null; source?: "office" | "automation" } = {}): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { sent: false, skipped: NOT_CONNECTED };
  const to = toE164(phone);
  if (!to) return { sent: false, skipped: "No mobile number on file" };
  const thread = await threadFor(companyId, to, o.employeeId ? { employeeId: o.employeeId } : undefined);
  const row = await addText(thread, { direction: "out", body, status: "sending", source: o.source ?? "automation", sentById: o.by ?? null });
  const sent = await deliver(cfg, row!);
  return sent.status === "failed" ? { sent: false, error: sent.error ?? "Not sent" } : { sent: true };
}

/* ───────────── Sending to many ───────────── */

export type QueuedText = { phone: string; body: string; customerId?: string | null; employeeId?: string | null };

/** Lines the texts up to go out a few a minute (carriers slow or block a burst), and starts on them. */
export async function queueTexts(companyId: string, o: { body: string; label: string; by: string | null; texts: QueuedText[]; skipped: { name: string; reason: string }[]; sendAt?: Date | null }) {
  const [batch] = await db.insert(textBatches).values({ companyId, body: o.body, label: o.label.slice(0, 300), total: o.texts.length, skipped: o.skipped.slice(0, 2000), createdById: o.by }).returning();
  for (const t of o.texts) {
    const thread = await threadFor(companyId, t.phone, { customerId: t.customerId, employeeId: t.employeeId });
    await addText(thread, { customerId: t.customerId ?? null, employeeId: t.employeeId ?? null, batchId: batch.id, direction: "out", body: t.body, status: o.sendAt ? "scheduled" : "queued", sendAt: o.sendAt ?? null, source: "office", sentById: o.by });
  }
  if (!o.sendAt) void runTextQueue().catch((err) => console.error("sending queued texts failed", err));
  return batch;
}

/** How long to wait between queued texts (ms). Tests set it to 0. */
export const TEXT_QUEUE = { gapMs: Number(process.env.TEXT_QUEUE_GAP_MS ?? 3000) };
let draining: Promise<number> | null = null;

/** Sends the texts waiting in line, oldest first, one at a time. Safe to call often: only one run at a time. */
export function runTextQueue(max = 400): Promise<number> {
  draining ??= drain(max).finally(() => { draining = null; });
  return draining;
}

/** Picks up a send to many that a restart left waiting (the scheduler calls this every pass). */
export async function resumeTextQueue() {
  // A text cut off mid-send by a restart: say so rather than risk texting someone twice.
  await db.update(customerTexts).set({ status: "failed", error: "The server restarted while this was sending. Check with the customer before sending it again." })
    .where(and(eq(customerTexts.status, "sending"), sql`${customerTexts.batchId} is not null`, sql`${customerTexts.createdAt} < now() - interval '15 minutes'`));
  const [waiting] = await db.select({ id: customerTexts.id }).from(customerTexts).where(eq(customerTexts.status, "queued")).limit(1);
  if (waiting) void runTextQueue().catch((err) => console.error("sending queued texts failed", err));
}

async function drain(max: number) {
  let n = 0;
  while (n < max) {
    const picked = await db.execute(sql`
      update customer_texts set status = 'sending', created_at = now()
      where id = (select t.id from customer_texts t left join text_batches b on b.id = t.batch_id
                  where t.status = 'queued' and b.stopped_at is null order by t.created_at, t.id limit 1 for update of t skip locked)
      returning id`);
    const id = (picked.rows[0] as { id: string } | undefined)?.id;
    if (!id) break;
    const [row] = await db.select().from(customerTexts).where(eq(customerTexts.id, id));
    const fail = async (error: string) => { const [u] = await db.update(customerTexts).set({ status: "failed", error }).where(eq(customerTexts.id, id)).returning(); await touchThread(u); };
    const cfg = await textingConfig(row.companyId);
    if (!cfg) { await fail(NOT_CONNECTED); continue; }
    // They may have replied STOP since it was lined up.
    const [cust] = row.customerId ? await db.select({ out: customers.textOptOutAt }).from(customers).where(eq(customers.id, row.customerId)) : [];
    if (cust?.out) { await fail("They replied STOP"); continue; }
    await touchThread(row);
    const sent = await deliver(cfg, row);
    n++;
    const status = (sent as Row & { providerStatus?: number }).providerStatus;
    if (sent.status === "failed" && status === 429) {
      // Going too fast for the provider: put it back and try again on the next pass.
      await db.update(customerTexts).set({ status: "queued", error: null }).where(eq(customerTexts.id, id));
      break;
    }
    if (sent.status === "failed" && (status === 401 || status === 402)) {
      // Nothing more will go through until the plan or key is fixed: stop the rest rather than fail them one by one.
      await db.update(customerTexts).set({ status: "failed", error: sent.error }).where(and(eq(customerTexts.companyId, row.companyId), eq(customerTexts.status, "queued")));
      continue;
    }
    if (TEXT_QUEUE.gapMs) await new Promise((r) => setTimeout(r, TEXT_QUEUE.gapMs));
  }
  return n;
}

/* ───────────── Texts coming in ───────────── */

/** Whether the provider is telling Crewdesk about a text it already has (its webhook and its list name the same text differently). */
async function alreadyHave(companyId: string, phone: string, direction: "in" | "out", m: Inbound) {
  const fromHook = m.id.startsWith("evt:");
  const near = sql`${customerTexts.createdAt} between ${new Date(+m.at - 180_000).toISOString()}::timestamptz and ${new Date(+m.at + 180_000).toISOString()}::timestamptz`;
  const otherKind = direction === "out"
    // A text Crewdesk sent itself (or one already noted): the provider reports those too.
    ? sql`true`
    : fromHook ? sql`${customerTexts.providerId} not like 'evt:%'` : sql`${customerTexts.providerId} like 'evt:%'`;
  const [row] = await db.select({ id: customerTexts.id }).from(customerTexts)
    .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.phone, phone), eq(customerTexts.direction, direction), eq(customerTexts.body, m.body.slice(0, 2000)), near, otherKind)).limit(1);
  return !!row;
}

/**
 * A text the provider reports: keep it (once). One that came in is filed under whoever's number
 * it is, STOP and START are honored, and the people picked are told. One sent from the
 * provider's own app is added to the conversation so the history is whole. With `history`
 * (bringing in past conversations) nobody is told and nothing counts as unread.
 */
export async function receiveText(companyId: string, m: Inbound, o: { history?: boolean } = {}) {
  const phone = toE164(m.from) ?? m.from;
  const direction = m.direction ?? "in";
  if (await alreadyHave(companyId, phone, direction, m)) return null;
  const thread = await threadFor(companyId, phone);
  const fromHook = m.id.startsWith("evt:");
  const row = direction === "out"
    ? await addText(thread, { direction: "out", body: m.body.slice(0, 2000), status: "sent", providerId: m.id, source: "talkroute", createdAt: m.at })
    : await addText(thread, { direction: "in", body: m.body.slice(0, 2000), status: "received", providerId: m.id, source: "office", createdAt: m.at, ...(o.history ? { readAt: new Date() } : {}) });
  if (!row) return null;
  // Its pictures: listed with it when the provider was asked, looked up when the provider called.
  if (m.media?.length) await pullMedia(row, m.media);
  else if (fromHook && !o.history) {
    const cfg = await textingConfig(companyId);
    if (cfg) { const p = enrich(cfg, row, m).finally(() => enriching.delete(p)); enriching.add(p); }
  }
  if (direction === "out") return row;
  const kw = textKeyword(m.body);
  if (thread.customerId && kw) await db.update(customers).set({ textOptOutAt: kw === "stop" ? m.at : null }).where(eq(customers.id, thread.customerId));
  // A property contact (a tenant, say) who gets service notifications by text can stop them the same way.
  if (kw) await db.update(propertyContacts).set({ textOptOutAt: kw === "stop" ? m.at : null }).where(and(eq(propertyContacts.companyId, companyId), sql`${digits10(propertyContacts.cellPhone)} = ${phone.replace(/\D/g, "").slice(-10)}`));
  if (o.history) return row;
  const who = await threadName(thread);
  const told = await tellAbout(companyId, thread);
  notify(companyId, told.ids, {
    category: "texts",
    title: kw === "stop" ? `${who} replied STOP (no more texts)` : `Text from ${who}`,
    body: (m.body === PICTURE_NOTE ? "📷 Picture" : m.body).slice(0, 200),
    link: { screen: "texts", threadId: thread.id },
  }, { inboxOnly: told.quiet });
  if (!kw) await afterHoursReply(companyId, thread, m.at).catch((e) => console.error("The after-hours reply failed:", (e as Error).message));
  return row;
}

/** Who hears about a conversation's texts: the person it's assigned to, else the team. Anyone in their quiet hours gets it in their inbox only. */
async function tellAbout(companyId: string, thread: Thread, at = new Date()) {
  const people = await textPeople(companyId);
  const team = await textTeam(companyId);
  const assigned = thread.assignedId && people.some((p) => p.id === thread.assignedId) ? thread.assignedId : null;
  const ids = assigned ? [assigned] : team.ids;
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const quietRows = ids.length ? await db.select({ id: employees.id, q: employees.textQuiet }).from(employees).where(inArray(employees.id, ids)) : [];
  return { ids, quiet: quietRows.filter((r) => inQuietHours(r.q, at, co?.tz ?? "America/Chicago")).map((r) => r.id) };
}

const AUTO_GAP_MS = 8 * 3_600_000;
/** Whether an automatic text (after-hours reply, missed-call text) may go to this conversation now: not to the team, not to someone who said STOP, and not twice in a row. */
async function mayAutoText(thread: Thread, at: Date) {
  if (thread.employeeId || thread.phone.replace(/\D/g, "").length < 11) return false;
  if (Math.abs(Date.now() - +at) > 10 * 60_000) return false; // old news (a catch-up): too late to be useful
  if (thread.autoRepliedAt && Date.now() - +thread.autoRepliedAt < AUTO_GAP_MS) return false;
  const [cust] = thread.customerId ? await db.select({ out: customers.textOptOutAt }).from(customers).where(eq(customers.id, thread.customerId)) : [];
  return !cust?.out;
}
async function autoText(companyId: string, thread: Thread, message: string) {
  const body = fillTemplateText(message, await templateVars(companyId, { customerId: thread.customerId }));
  if (!body) return;
  // Marked first, so two things arriving together can't both set it off.
  const claimed = await db.update(textThreads).set({ autoRepliedAt: new Date() })
    .where(and(eq(textThreads.id, thread.id), sql`(${textThreads.autoRepliedAt} is null or ${textThreads.autoRepliedAt} < now() - interval '8 hours')`)).returning({ id: textThreads.id });
  if (claimed.length) await sendThreadText(companyId, thread.id, body, { by: null, source: "auto" });
}

/** Someone texted while the office is closed: the reply the office wrote for that, if it's turned on. */
async function afterHoursReply(companyId: string, thread: Thread, at: Date) {
  const [co] = await db.select({ o: companies.textingOptions, tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const auto = textingChoices(co?.o).autoReply;
  if (!auto.enabled || officeOpen(auto.hours, at, co?.tz ?? "America/Chicago") || !(await mayAutoText(thread, at))) return;
  await autoText(companyId, thread, auto.message);
}

/**
 * A call or voicemail the provider reports: kept (once) for the customer's page. A call from
 * outside that nobody answered gets the "sorry we missed you" text, if that's turned on.
 */
export async function receiveCall(companyId: string, ev: CallEvent) {
  const phone = toE164(ev.phone) ?? ev.phone;
  const who = await whoHasNumber(companyId, phone);
  const [row] = await db.insert(phoneCalls).values({
    companyId, phone, customerId: who.customerId, employeeId: who.employeeId, kind: ev.kind, direction: ev.direction, result: ev.result, durationSeconds: ev.durationSeconds,
    callerName: ev.callerName, transcript: ev.transcript?.slice(0, 4000) ?? null, providerId: ev.id, at: ev.at,
  }).onConflictDoNothing().returning();
  if (!row) return null;
  const missed = ev.direction === "in" && (ev.kind === "voicemail" || ev.result === "missed");
  if (missed) {
    const [co] = await db.select({ o: companies.textingOptions }).from(companies).where(eq(companies.id, companyId));
    const mc = textingChoices(co?.o).missedCall;
    if (mc.enabled && (await textingConfig(companyId))) {
      const thread = await threadFor(companyId, phone, who);
      if (await mayAutoText(thread, ev.at)) await autoText(companyId, thread, mc.message).catch((e) => console.error("The missed-call text failed:", (e as Error).message));
    }
  }
  return row;
}

/** Who a conversation is with, in words: the customer, the employee, or the number. */
export async function threadName(t: Pick<Thread, "customerId" | "employeeId" | "phone">) {
  if (t.customerId) { const [c] = await db.select().from(customers).where(eq(customers.id, t.customerId)); if (c) return customerName(c); }
  if (t.employeeId) { const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, t.employeeId)); if (e) return `${e.f} ${e.l}`; }
  return formatPhone(t.phone);
}

/** The provider calling about a new text, call or voicemail. Only a call signed with this company's secret is believed. */
export async function receiveHook(token: string, kind: HookKind, headers: Record<string, unknown>, raw: Buffer): Promise<"ok" | "unknown" | "bad-signature" | "ignored"> {
  if (!/^[0-9a-f]{48}$/.test(token)) return "unknown";
  const [c] = await db.select({ id: companies.id, t: companies.texting, s: companies.textingHookSecret }).from(companies).where(eq(companies.textingHookToken, token));
  const secret = c?.t ? hookSecrets(c.s)[kind] : undefined;
  if (!c?.t || !secret || !provider.verify || !provider.parseHook) return "unknown";
  if (!provider.verify(secret, headers, raw)) return "bad-signature";
  await db.update(companies).set({ texting: sql`jsonb_set(${companies.texting}, '{hookAt}', to_jsonb(${new Date().toISOString()}::text))` }).where(eq(companies.id, c.id));
  if (kind === "text") {
    const m = provider.parseHook(raw);
    // Another of the account's numbers: not this company's texting number.
    if (!m || (toE164(m.ours) ?? m.ours) !== c.t.fromNumber) return "ignored";
    await receiveText(c.id, m);
    return "ok";
  }
  const ev = provider.parseCall?.(raw, kind);
  if (!ev || (toE164(ev.ours) ?? ev.ours) !== c.t.fromNumber) return "ignored";
  await receiveCall(c.id, ev);
  return "ok";
}

/* ───────────── Written to go later ───────────── */

/** Texts whose time has come join the line to be sent (the scheduler calls this every half minute). */
export async function releaseScheduledTexts(now = new Date()) {
  const due = await db.update(customerTexts).set({ status: "queued" }).where(and(eq(customerTexts.status, "scheduled"), lte(customerTexts.sendAt, now))).returning({ id: customerTexts.id });
  if (due.length) void runTextQueue().catch((err) => console.error("sending scheduled texts failed", err));
  return due.length;
}

/* ───────────── Long jobs: past conversations, and customers into the provider's contacts ───────────── */

const setJob = (companyId: string, key: "history" | "contacts", job: TextingJob) =>
  db.update(companies).set({ textingOptions: sql`coalesce(${companies.textingOptions}, '{}'::jsonb) || ${JSON.stringify({ [key]: job })}::jsonb` }).where(eq(companies.id, companyId));
const jobs = new Set<Promise<void>>();
/** Waits for the long jobs (tests). */
export async function flushTextJobs() { while (jobs.size) await Promise.all([...jobs]); }
function background(run: () => Promise<void>) { const p = run().finally(() => jobs.delete(p)); jobs.add(p); }
const running = (j: TextingJob | null | undefined) => !!j && !j.finishedAt && Date.now() - +new Date(j.startedAt) < 6 * 3_600_000;

/** Brings in the conversations of the last `days` days from the provider, as history: nobody is told, nothing is unread. */
export async function startHistoryImport(companyId: string, days: number) {
  const cfg = await textingConfig(companyId);
  if (!cfg) throw new HttpError(400, "Connect texting first");
  if (!provider.history) throw new HttpError(400, "Past conversations can't be brought in from this texting service");
  const [co] = await db.select({ o: companies.textingOptions }).from(companies).where(eq(companies.id, companyId));
  if (running(co?.o?.history)) throw new HttpError(400, "Past conversations are already being brought in");
  const job: TextingJob = { startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: 0, added: 0, error: null };
  await setJob(companyId, "history", job);
  const since = new Date(Date.now() - days * 86_400_000);
  background(async () => {
    try {
      await provider.history!(cfg, since,
        async (m) => { if (await receiveText(companyId, m, { history: true })) job.added++; },
        async (done, total) => { job.done = done; job.total = total; await setJob(companyId, "history", job); });
      // Conversations that went quiet a month ago or more aren't waiting on anyone.
      await db.update(textThreads).set({ status: "done" }).where(and(eq(textThreads.companyId, companyId), eq(textThreads.unread, 0), sql`${textThreads.lastAt} < now() - interval '30 days'`, sql`${textThreads.createdAt} >= ${job.startedAt}::timestamptz`));
    } catch (e) { job.error = (e as Error).message.slice(0, 300); }
    job.finishedAt = new Date().toISOString();
    await setJob(companyId, "history", job);
  });
  return job;
}

/**
 * Copies customers (with a phone number) into the provider's contacts, so their names show in its
 * apps. Ones already copied are left as they are. Run again any time; once it's been run, new
 * customers are copied overnight.
 */
export async function startContactsCopy(companyId: string) {
  const cfg = await textingConfig(companyId);
  if (!cfg) throw new HttpError(400, "Connect texting first");
  if (!provider.addContacts) throw new HttpError(400, "Customers can't be copied to this texting service");
  const [co] = await db.select({ o: companies.textingOptions }).from(companies).where(eq(companies.id, companyId));
  if (running(co?.o?.contacts)) throw new HttpError(400, "Customers are already being copied");
  const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), eq(customers.sample, false), sql`${customers.status} <> 'cancelled'`)).orderBy(asc(customers.number));
  const people = rows.map((c) => ({
    id: c.id, name: customerName(c), phones: [...new Set([toE164(c.phone), toE164(c.altPhone)].filter((x): x is string => !!x))], email: c.email,
    company: c.companyName && customerName(c) !== c.companyName ? c.companyName : null, notes: `Crewdesk customer #${c.number}`,
  })).filter((p) => p.phones.length);
  const job: TextingJob = { startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: people.length, added: 0, error: null };
  await setJob(companyId, "contacts", job);
  background(async () => {
    try {
      for (let i = 0; i < people.length; i += 100) {
        const r = await provider.addContacts!(cfg, people.slice(i, i + 100));
        job.added += r.added; job.done = Math.min(people.length, i + 100);
        await setJob(companyId, "contacts", job);
      }
    } catch (e) { job.error = (e as Error).message.slice(0, 300); }
    job.finishedAt = new Date().toISOString();
    await setJob(companyId, "contacts", job);
  });
  return job;
}

/** Overnight: companies that copy their customers to the provider get the new ones copied (at most once a day). */
export async function refreshContacts() {
  const rows = await db.select({ id: companies.id, o: companies.textingOptions }).from(companies).where(sql`${companies.texting} is not null and ${companies.textingOptions} -> 'contacts' is not null`);
  for (const r of rows) {
    const last = r.o?.contacts;
    if (!last?.finishedAt || last.error || Date.now() - +new Date(last.finishedAt) < 24 * 3_600_000) continue;
    await startContactsCopy(r.id).catch((e) => console.error("Copying customers to the texting service failed:", (e as Error).message));
  }
}

/* ───────────── From a text to a to-do ───────────── */

/** Makes a to-do out of a conversation (its latest text, or the one picked), for the person asking, due today. */
export async function todoFromThread(companyId: string, threadId: string, by: string, textId?: string | null) {
  const [thread] = await db.select().from(textThreads).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
  if (!thread) throw new HttpError(404, "Conversation not found");
  const [text] = await db.select().from(customerTexts).where(and(eq(customerTexts.threadId, thread.id), textId ? eq(customerTexts.id, textId) : eq(customerTexts.direction, "in"))).orderBy(desc(customerTexts.createdAt)).limit(1);
  const who = await threadName(thread);
  const said = text && text.body && text.body !== PICTURE_NOTE ? text.body : "";
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const title = (said ? `${who}: ${said}` : `Text from ${who}`).replace(/\s+/g, " ").slice(0, 140);
  const notes = `From a text${text ? ` on ${text.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: co?.tz ?? "America/Chicago" })}` : ""} (${formatPhone(thread.phone)})${said ? `:\n"${said}"` : "."}`;
  const [t] = await db.insert(todos).values({ companyId, title, notes, customerId: thread.customerId, date: localDate(new Date(), co?.tz ?? "America/Chicago"), createdById: by }).returning();
  await db.insert(todoAssignees).values({ todoId: t.id, employeeId: by }).onConflictDoNothing();
  await addText(thread, { direction: "note", body: `To-do made: ${t.title}`, status: "note", source: "office", sentById: by });
  return t;
}

/**
 * Asks the provider for texts Crewdesk doesn't have yet. With a webhook in place this is only a
 * catch-up (every quarter hour); without one it's how texts arrive (every pass).
 */
export async function pollInboundTexts(force = false) {
  if (!provider.inbound) return 0;
  const rows = await db.select({ id: companies.id }).from(companies).where(sql`${companies.texting} is not null`);
  let n = 0;
  for (const { id } of rows) {
    // One company's trouble (a key Talkroute has revoked, say) doesn't hold up the others.
    try {
      const cfg = await textingConfig(id);
      if (!cfg) continue;
      if (!force && cfg.webhook && cfg.polledAt && Date.now() - +new Date(cfg.polledAt) < 15 * 60_000) continue;
      const since = cfg.inboundSince ? new Date(cfg.inboundSince) : new Date(Date.now() - 3_600_000);
      const got = await provider.inbound(cfg, since);
      let latest = since;
      for (const m of got) { if (await receiveText(id, m)) n++; if (m.at > latest) latest = m.at; }
      await db.update(companies).set({ texting: sql`${companies.texting} || ${JSON.stringify({ inboundSince: latest.toISOString(), polledAt: new Date().toISOString() })}::jsonb` }).where(eq(companies.id, id));
    } catch (e) {
      console.error("Checking for new texts failed:", (e as Error).message);
    }
  }
  return n;
}

/** Marks a conversation's replies read (when someone opens it). */
export async function markThreadRead(companyId: string, threadId: string) {
  await db.update(customerTexts).set({ readAt: new Date() }).where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.threadId, threadId), eq(customerTexts.direction, "in"), isNull(customerTexts.readAt)));
  await db.update(textThreads).set({ unread: 0 }).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
}

/** Marks a customer's replies read (when someone opens their texts on the customer's page). */
export async function markTextsRead(companyId: string, customerId: string) {
  await db.update(customerTexts).set({ readAt: new Date() })
    .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.customerId, customerId), eq(customerTexts.direction, "in"), isNull(customerTexts.readAt)));
  await db.update(textThreads).set({ unread: 0 }).where(and(eq(textThreads.companyId, companyId), eq(textThreads.customerId, customerId)));
}
