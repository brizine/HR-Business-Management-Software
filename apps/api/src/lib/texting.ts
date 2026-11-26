import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { INACTIVE_STATUSES, customerName, formatPhone, textKeyword, toE164 } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customerTexts, customers, employees, textBatches, textThreads } from "../db/schema";
import { isManager } from "./auth";
import { PUBLIC_API_URL } from "./channels";
import { decrypt, encrypt } from "./crypto";
import { HttpError } from "./errors";
import { notify, staffWithRole } from "./notify";
import { talkroute } from "./talkroute";

/**
 * Texting from the company's own number. A provider (Talkroute) sends the texts and tells
 * Crewdesk about the ones that come in; Crewdesk keeps each conversation (one per phone number,
 * filed under the customer or employee whose number it is), honors STOP and START, and tells
 * the people the company picked about every text that arrives.
 */

const PURPOSE = "texting";
const HOOK_PURPOSE = "texting-hook";
type Config = { key: string; fromNumber: string };
/** A text the provider reports. "out": sent from the provider's own app rather than Crewdesk. */
export type Inbound = { id: string; from: string; body: string; at: Date; direction?: "in" | "out" };
export type TextNumber = { number: string; label: string | null; canSend: boolean; registered?: boolean | null };

export interface TextingProvider {
  /** Whether this provider can be connected yet. */
  ready: boolean;
  /** Checks the key and number with the provider (throws with a clear message if they're wrong). */
  check(c: Config): Promise<{ accountName?: string | null }>;
  /** The account's numbers that can text, to pick the one Crewdesk uses. */
  numbers?(key: string): Promise<TextNumber[]>;
  send(c: Config, to: string, body: string): Promise<{ id: string; status?: "sent" | "delivered" }>;
  /** Texts since `since`, oldest first (asked for now and then, to catch anything a webhook missed). */
  inbound?(c: Config, since: Date): Promise<Inbound[]>;
  /** Asks the provider to call `url` about each new text; what comes back verifies its calls and takes it off again. */
  subscribe?(c: Config, url: string): Promise<{ id: string; secret: string }>;
  unsubscribe?(c: Config, id: string): Promise<void>;
  verify?(secret: string, headers: Record<string, unknown>, raw: Buffer): boolean;
  parseHook?(raw: Buffer): (Inbound & { ours: string }) | null;
}

let provider: TextingProvider = talkroute;
/** Tests swap in a pretend provider. */
export function setTextingProvider(p: TextingProvider | null) { provider = p ?? talkroute; }
export const textingProvider = () => provider;

type Stored = NonNullable<(typeof companies.$inferSelect)["texting"]>;
export async function textingConfig(companyId: string): Promise<(Config & Omit<Stored, "provider" | "fromNumber"> & { accountName: string | null; inboundSince: string | null; webhook: boolean }) | null> {
  const [c] = await db.select({ t: companies.texting, k: companies.textingKey, s: companies.textingHookSecret }).from(companies).where(eq(companies.id, companyId));
  if (!c?.t || !c.k) return null;
  return { ...c.t, key: decrypt(c.k, PURPOSE), fromNumber: c.t.fromNumber, accountName: c.t.accountName ?? null, inboundSince: c.t.inboundSince ?? null, webhook: !!(c.t.subscriptionId && c.s) };
}

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
  // A connection being replaced: take its webhook off first.
  const before = await textingConfig(companyId);
  if (before?.subscriptionId && provider.unsubscribe) await provider.unsubscribe(before, before.subscriptionId).catch(() => {});
  const token = crypto.randomBytes(24).toString("hex");
  let sub: { id: string; secret: string } | null = null, webhookError: string | undefined;
  if (provider.subscribe) {
    try { sub = await provider.subscribe(cfg, `${PUBLIC_API_URL}/texting/hooks/talkroute/${token}`); } catch (e) { webhookError = (e as Error).message; }
  }
  const now = new Date().toISOString();
  await db.update(companies).set({
    texting: { provider: "talkroute", fromNumber: from, connectedAt: now, accountName: accountName ?? null, inboundSince: now, subscriptionId: sub?.id ?? null, hookAt: null, polledAt: null },
    textingKey: encrypt(apiKey, PURPOSE),
    textingHookSecret: sub ? encrypt(sub.secret, HOOK_PURPOSE) : null,
    textingHookToken: sub ? token : null,
  }).where(eq(companies.id, companyId));
  return { webhook: !!sub, webhookError };
}

export async function disconnectTexting(companyId: string) {
  const cfg = await textingConfig(companyId);
  if (cfg?.subscriptionId && provider.unsubscribe) await provider.unsubscribe(cfg, cfg.subscriptionId).catch(() => {});
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
  if (row.source !== "test" && row.status !== "queued") await touchThread(row);
  return row;
}

async function touchThread(row: Row) {
  if (!row.threadId) return;
  // The list shows the newest text (one brought in late doesn't push a newer one aside).
  await db.update(textThreads).set({ lastAt: row.createdAt, lastBody: row.body.slice(0, 300), lastDirection: row.direction, lastStatus: row.status })
    .where(and(eq(textThreads.id, row.threadId), sql`(${textThreads.lastAt} <= ${row.createdAt.toISOString()}::timestamptz or ${textThreads.lastBody} = '')`));
  // A reply counts as unread until someone opens it, and opens a conversation marked done again.
  if (row.direction === "in") await db.update(textThreads).set({ unread: sql`${textThreads.unread} + 1`, status: "open" }).where(eq(textThreads.id, row.threadId));
}

/** Hands a saved text to the provider and records how it went. */
async function deliver(cfg: Config, row: Row): Promise<Row> {
  try {
    const r = await provider.send(cfg, row.phone, row.body);
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
export async function sendThreadText(companyId: string, threadId: string, body: string, o: { by: string | null }): Promise<{ text: Row | null; skipped?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { text: null, skipped: NOT_CONNECTED };
  const [thread] = await db.select().from(textThreads).where(and(eq(textThreads.id, threadId), eq(textThreads.companyId, companyId)));
  if (!thread) throw new HttpError(404, "Conversation not found");
  const [cust] = thread.customerId ? await db.select().from(customers).where(eq(customers.id, thread.customerId)) : [];
  if (cust?.textOptOutAt) return { text: null, skipped: `${customerName(cust)} replied STOP, so they can't be texted until they reply START` };
  const row = await addText(thread, { direction: "out", body, status: "sending", source: "office", sentById: o.by });
  return { text: await deliver(cfg, row!) };
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
export async function queueTexts(companyId: string, o: { body: string; label: string; by: string | null; texts: QueuedText[]; skipped: { name: string; reason: string }[] }) {
  const [batch] = await db.insert(textBatches).values({ companyId, body: o.body, label: o.label.slice(0, 300), total: o.texts.length, skipped: o.skipped.slice(0, 2000), createdById: o.by }).returning();
  for (const t of o.texts) {
    const thread = await threadFor(companyId, t.phone, { customerId: t.customerId, employeeId: t.employeeId });
    await addText(thread, { customerId: t.customerId ?? null, employeeId: t.employeeId ?? null, batchId: batch.id, direction: "out", body: t.body, status: "queued", source: "office", sentById: o.by });
  }
  void runTextQueue().catch((err) => console.error("sending queued texts failed", err));
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
 * provider's own app is added to the conversation so the history is whole.
 */
export async function receiveText(companyId: string, m: Inbound) {
  const phone = toE164(m.from) ?? m.from;
  const direction = m.direction ?? "in";
  if (await alreadyHave(companyId, phone, direction, m)) return null;
  const thread = await threadFor(companyId, phone);
  if (direction === "out") {
    return addText(thread, { direction: "out", body: m.body.slice(0, 2000), status: "sent", providerId: m.id, source: "talkroute", createdAt: m.at });
  }
  const row = await addText(thread, { direction: "in", body: m.body.slice(0, 2000), status: "received", providerId: m.id, source: "office", createdAt: m.at });
  if (!row) return null;
  const kw = textKeyword(m.body);
  if (thread.customerId && kw) await db.update(customers).set({ textOptOutAt: kw === "stop" ? new Date() : null }).where(eq(customers.id, thread.customerId));
  const who = await threadName(thread);
  notify(companyId, (await textTeam(companyId)).ids, {
    category: "texts",
    title: kw === "stop" ? `${who} replied STOP (no more texts)` : `Text from ${who}`,
    body: m.body.slice(0, 200),
    link: { screen: "texts", threadId: thread.id },
  });
  return row;
}

/** Who a conversation is with, in words: the customer, the employee, or the number. */
export async function threadName(t: Pick<Thread, "customerId" | "employeeId" | "phone">) {
  if (t.customerId) { const [c] = await db.select().from(customers).where(eq(customers.id, t.customerId)); if (c) return customerName(c); }
  if (t.employeeId) { const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, t.employeeId)); if (e) return `${e.f} ${e.l}`; }
  return formatPhone(t.phone);
}

/** The provider calling about a new text. Only a call signed with this company's secret is believed. */
export async function receiveHook(token: string, headers: Record<string, unknown>, raw: Buffer): Promise<"ok" | "unknown" | "bad-signature" | "ignored"> {
  if (!/^[0-9a-f]{48}$/.test(token)) return "unknown";
  const [c] = await db.select({ id: companies.id, t: companies.texting, s: companies.textingHookSecret }).from(companies).where(eq(companies.textingHookToken, token));
  if (!c?.t || !c.s || !provider.verify || !provider.parseHook) return "unknown";
  if (!provider.verify(decrypt(c.s, HOOK_PURPOSE), headers, raw)) return "bad-signature";
  const m = provider.parseHook(raw);
  await db.update(companies).set({ texting: sql`jsonb_set(${companies.texting}, '{hookAt}', to_jsonb(${new Date().toISOString()}::text))` }).where(eq(companies.id, c.id));
  // Another of the account's numbers: not this company's texting number.
  if (!m || (toE164(m.ours) ?? m.ours) !== c.t.fromNumber) return "ignored";
  await receiveText(c.id, m);
  return "ok";
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
