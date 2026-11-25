import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { customerName, formatPhone, textKeyword, toE164 } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customerTexts, customers } from "../db/schema";
import { decrypt, encrypt } from "./crypto";
import { HttpError } from "./errors";
import { notify, staffWithRole } from "./notify";

/**
 * Texting customers from the company's own number. A provider (Talkroute) sends the texts and
 * gives Crewdesk the replies; Crewdesk keeps each conversation on the customer, honors STOP and
 * START, and tells the office about replies.
 */

const PURPOSE = "texting";
type Config = { key: string; fromNumber: string };
export type Inbound = { id: string; from: string; body: string; at: Date };

export interface TextingProvider {
  /** Whether this provider can be connected yet. */
  ready: boolean;
  /** Checks the key and number with the provider (throws with a clear message if they're wrong). */
  check(c: Config): Promise<{ accountName?: string | null }>;
  send(c: Config, to: string, body: string): Promise<{ id: string; status?: "sent" | "delivered" }>;
  /** Replies received since `since`, oldest first (for providers Crewdesk asks rather than being told). */
  inbound?(c: Config, since: Date): Promise<Inbound[]>;
}

/**
 * Talkroute. Its API needs a key Talkroute approves for the account, and its reference wasn't
 * reachable when this was built, so connecting says so until the calls are filled in.
 */
const talkroute: TextingProvider = {
  ready: false,
  async check() { throw new HttpError(400, "Texting through Talkroute isn't finished yet: it needs Talkroute's API details and an API key from Talkroute"); },
  async send() { throw new HttpError(400, "Texting isn't connected"); },
};

let provider: TextingProvider = talkroute;
/** Tests swap in a pretend provider. */
export function setTextingProvider(p: TextingProvider | null) { provider = p ?? talkroute; }
export const textingProvider = () => provider;

export async function textingConfig(companyId: string): Promise<(Config & { connectedAt: string; accountName: string | null; inboundSince: string | null }) | null> {
  const [c] = await db.select({ t: companies.texting, k: companies.textingKey }).from(companies).where(eq(companies.id, companyId));
  if (!c?.t || !c.k) return null;
  return { key: decrypt(c.k, PURPOSE), fromNumber: c.t.fromNumber, connectedAt: c.t.connectedAt, accountName: c.t.accountName ?? null, inboundSince: c.t.inboundSince ?? null };
}

export async function connectTexting(companyId: string, apiKey: string, fromNumber: string) {
  const from = toE164(fromNumber);
  if (!from) throw new HttpError(400, "Enter your Talkroute number, with its area code");
  const { accountName } = await provider.check({ key: apiKey, fromNumber: from }).catch((e) => {
    throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message || "Talkroute didn't accept those details");
  });
  await db.update(companies).set({
    texting: { provider: "talkroute", fromNumber: from, connectedAt: new Date().toISOString(), accountName: accountName ?? null, inboundSince: new Date().toISOString() },
    textingKey: encrypt(apiKey, PURPOSE),
  }).where(eq(companies.id, companyId));
}

export async function disconnectTexting(companyId: string) {
  await db.update(companies).set({ texting: null, textingKey: null }).where(eq(companies.id, companyId));
}

/** The number to text a customer at: their phone, else their other phone (US numbers). */
export const textNumberFor = (c: { phone: string | null; altPhone: string | null }) => toE164(c.phone) ?? toE164(c.altPhone);

type Row = typeof customerTexts.$inferSelect;

/**
 * Texts a customer. Skips (with a reason) when texting isn't connected, they have no number, or
 * they replied STOP. The text is saved either way it goes, so it shows on their page.
 */
export async function sendCustomerText(companyId: string, customerId: string, body: string, o: { by: string | null; source: "office" | "automation" }): Promise<{ text: Row | null; skipped?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { text: null, skipped: "Texting isn't connected (Settings → Integrations)" };
  const [cust] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!cust) throw new HttpError(404, "Customer not found");
  if (cust.textOptOutAt) return { text: null, skipped: `${customerName(cust)} replied STOP, so they can't be texted until they reply START` };
  const to = textNumberFor(cust);
  if (!to) return { text: null, skipped: `${customerName(cust)} has no mobile number on file` };
  const [row] = await db.insert(customerTexts).values({ companyId, customerId, direction: "out", phone: to, body, status: "sending", source: o.source, sentById: o.by }).returning();
  try {
    const r = await provider.send(cfg, to, body);
    const [u] = await db.update(customerTexts).set({ status: r.status ?? "sent", providerId: r.id }).where(eq(customerTexts.id, row.id)).returning();
    return { text: u };
  } catch (e) {
    const [u] = await db.update(customerTexts).set({ status: "failed", error: (e as Error).message.slice(0, 500) }).where(eq(customerTexts.id, row.id)).returning();
    return { text: u };
  }
}

/**
 * Texts the owner or an employee from the company's number (automations). Not kept with the
 * customer's texts; the automation's history says what went.
 */
export async function sendStaffText(companyId: string, phone: string | null, body: string): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  const cfg = await textingConfig(companyId);
  if (!cfg) return { sent: false, skipped: "Texting isn't connected (Settings → Integrations)" };
  const to = toE164(phone);
  if (!to) return { sent: false, skipped: "No mobile number on file" };
  try {
    await provider.send(cfg, to, body);
    return { sent: true };
  } catch (e) {
    return { sent: false, error: (e as Error).message.slice(0, 300) };
  }
}

/** The customer (if any) a number belongs to: their phone or other phone, then a contact's. */
async function customerForNumber(companyId: string, e164: string) {
  const ten = e164.replace(/\D/g, "").slice(-10);
  const digits = (col: unknown) => sql`right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
  const [c] = await db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.companyId, companyId), or(sql`${digits(customers.phone)} = ${ten}`, sql`${digits(customers.altPhone)} = ${ten}`)))
    .orderBy(sql`${customers.status} = 'active' desc`, desc(customers.createdAt)).limit(1);
  if (c) return c.id;
  const [k] = await db.select({ id: customerContacts.customerId }).from(customerContacts).innerJoin(customers, eq(customers.id, customerContacts.customerId))
    .where(and(eq(customers.companyId, companyId), sql`${digits(customerContacts.phone)} = ${ten}`)).limit(1);
  return k?.id ?? null;
}

/** A reply came in: keep it (once), handle STOP and START, and tell the office. */
export async function receiveText(companyId: string, m: Inbound) {
  const from = toE164(m.from) ?? m.from;
  const customerId = await customerForNumber(companyId, from);
  const [row] = await db.insert(customerTexts).values({ companyId, customerId, direction: "in", phone: from, body: m.body.slice(0, 2000), status: "received", providerId: m.id, source: "office", createdAt: m.at })
    .onConflictDoNothing().returning();
  if (!row) return null;
  const kw = textKeyword(m.body);
  if (customerId && kw) await db.update(customers).set({ textOptOutAt: kw === "stop" ? new Date() : null }).where(eq(customers.id, customerId));
  const [cust] = customerId ? await db.select().from(customers).where(eq(customers.id, customerId)) : [];
  const who = cust ? customerName(cust) : formatPhone(from);
  notify(companyId, await staffWithRole(companyId, "manager", "customers"), {
    category: "customers",
    title: kw === "stop" ? `${who} replied STOP (no more texts)` : `Text from ${who}`,
    body: m.body.slice(0, 200),
    link: cust ? { screen: "customer", id: cust.id } : { screen: "texts" },
  });
  return row;
}

/** Asks the provider for new replies (every few minutes, for each connected company). */
export async function pollInboundTexts() {
  if (!provider.inbound) return 0;
  const rows = await db.select({ id: companies.id }).from(companies).where(sql`${companies.texting} is not null`);
  let n = 0;
  for (const { id } of rows) {
    const cfg = await textingConfig(id);
    if (!cfg) continue;
    try {
      const since = cfg.inboundSince ? new Date(cfg.inboundSince) : new Date(Date.now() - 3_600_000);
      const got = await provider.inbound(cfg, since);
      let latest = since;
      for (const m of got) { if (await receiveText(id, m)) n++; if (m.at > latest) latest = m.at; }
      if (latest > since) await db.update(companies).set({ texting: sql`jsonb_set(${companies.texting}, '{inboundSince}', to_jsonb(${latest.toISOString()}::text))` }).where(eq(companies.id, id));
    } catch (e) {
      console.error("Checking for new texts failed:", (e as Error).message);
    }
  }
  return n;
}

/** Marks a customer's replies read (when someone opens the conversation). */
export async function markTextsRead(companyId: string, customerId: string) {
  await db.update(customerTexts).set({ readAt: new Date() })
    .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.customerId, customerId), eq(customerTexts.direction, "in"), isNull(customerTexts.readAt)));
}
