import { promises as dnsPromises } from "node:dns";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { customerName } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customers, emailLog } from "../db/schema";

/**
 * Email deliverability: is the sending domain set up so mail lands in inboxes (SPF, DKIM, DMARC),
 * did the mail service take what was sent to this company's customers, and are there customer
 * addresses that can't get email (none, mistyped, a domain that takes no mail, unsubscribed).
 */

type Resolver = { resolveTxt(name: string): Promise<string[][]>; resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>; resolve4(name: string): Promise<string[]> };
let dns: Resolver = dnsPromises;
/** Tests use a pretend DNS. */
export function setDnsResolver(r: Resolver | null) { dns = r ?? dnsPromises; cache.clear(); }

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** TXT records joined per record; [] when there are none; null when DNS didn't answer. */
async function txt(name: string): Promise<string[] | null> {
  try { return (await dns.resolveTxt(name)).map((parts) => parts.join("")); }
  catch (e) { const code = (e as { code?: string }).code; return code === "ENOTFOUND" || code === "ENODATA" || code === "ENOTIMP" ? [] : null; }
}

/** The domain mail is sent from (EMAIL_FROM), and the mail service's host (never its login). */
export function sendingSetup() {
  const from = process.env.EMAIL_FROM ?? "";
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  const domain = address.includes("@") ? address.split("@")[1].trim().toLowerCase() : null;
  let host: string | null = null;
  try { host = process.env.SMTP_URL ? new URL(process.env.SMTP_URL).hostname : null; } catch { host = null; }
  return { configured: !!process.env.SMTP_URL, from: address || null, domain, host };
}

// DKIM keys live at <selector>._domainkey.<domain>; the selector depends on the mail service.
const SELECTORS = ["default", "google", "selector1", "selector2", "s1", "s2", "k1", "k2", "pm", "mail", "dkim", "smtp", "mandrill", "mxvault", "resend", "sendgrid", "ses", "amazonses", "scph0920", "x"];

export type DomainCheck = {
  domain: string;
  spf: { status: "ok" | "missing" | "too_many" | "unknown"; record: string | null; softOnly: boolean };
  dkim: { status: "ok" | "not_found" | "unknown"; selector: string | null };
  dmarc: { status: "ok" | "missing" | "unknown"; policy: string | null; record: string | null };
};

/** Whether DNS lookups work from here at all (gmail.com always has mail servers). */
export function dnsWorks(): Promise<boolean> {
  return cached("dns-works", 60 * 60_000, async () => { try { return (await dns.resolveMx("gmail.com")).length > 0; } catch { return false; } });
}

const UNKNOWN = (domain: string): DomainCheck => ({ domain, spf: { status: "unknown", record: null, softOnly: false }, dkim: { status: "unknown", selector: null }, dmarc: { status: "unknown", policy: null, record: null } });

export function checkDomain(domain: string): Promise<DomainCheck> {
  return cached(`domain:${domain}`, 60 * 60_000, async () => {
    // Without working DNS, "no record" would be a guess: say it couldn't be checked.
    if (!(await dnsWorks())) return UNKNOWN(domain);
    const root = await txt(domain);
    const spfs = (root ?? []).filter((r) => /^v=spf1\b/i.test(r.trim()));
    const spf: DomainCheck["spf"] = root === null ? { status: "unknown", record: null, softOnly: false }
      : spfs.length === 0 ? { status: "missing", record: null, softOnly: false }
      : spfs.length > 1 ? { status: "too_many", record: spfs.join("  |  "), softOnly: false }
      : { status: "ok", record: spfs[0], softOnly: !/[-~]all\b/i.test(spfs[0]) };
    const dm = await txt(`_dmarc.${domain}`);
    const dmRec = (dm ?? []).find((r) => /^v=DMARC1\b/i.test(r.trim())) ?? null;
    const dmarc: DomainCheck["dmarc"] = dm === null ? { status: "unknown", policy: null, record: null }
      : dmRec ? { status: "ok", policy: dmRec.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase() ?? null, record: dmRec } : { status: "missing", policy: null, record: null };
    const selectors = [...new Set([...(process.env.DKIM_SELECTOR ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...SELECTORS])];
    let dkim: DomainCheck["dkim"] = { status: "not_found", selector: null };
    let anyAnswer = false;
    for (const sel of selectors) {
      const r = await txt(`${sel}._domainkey.${domain}`);
      if (r !== null) anyAnswer = true;
      if (r?.some((x) => /\bp=[A-Za-z0-9+/]/.test(x) || /v=DKIM1/i.test(x))) { dkim = { status: "ok", selector: sel }; break; }
    }
    if (dkim.status !== "ok" && !anyAnswer) dkim = { status: "unknown", selector: null };
    return { domain, spf, dkim, dmarc };
  });
}

/** Whether a domain can take email (an MX record, or an address to fall back on); null when DNS didn't answer. */
export function domainTakesMail(domain: string): Promise<boolean | null> {
  return cached(`mx:${domain}`, 24 * 60 * 60_000, async () => {
    try { const mx = await dns.resolveMx(domain); if (mx.some((m) => m.exchange && m.exchange !== ".")) return true; return false; }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENODATA") { try { return (await dns.resolve4(domain)).length > 0; } catch { return false; } }
      return code === "ENOTFOUND" ? false : null;
    }
  });
}

/** Big providers that certainly take mail (no need to look them up). */
const KNOWN = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "att.net", "sbcglobal.net", "cox.net", "comcast.net", "verizon.net", "protonmail.com", "proton.me", "ymail.com", "rocketmail.com", "bellsouth.net", "charter.net", "gmx.com", "mail.com", "zoho.com", "fastmail.com"]);
/** Common slips of big providers' names. */
const TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmaill.com": "gmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahoo.con": "yahoo.com", "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com", "outlook.co": "outlook.com", "iclod.com": "icloud.com", "icloud.co": "icloud.com", "aol.co": "aol.com", "comcast.ner": "comcast.net", "sbcglobal.ent": "sbcglobal.net",
};
const VALID = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export type AddressProblem = { customerId: string; name: string; email: string; problem: string };

/** The deliverability box for one company. */
export async function emailHealth(companyId: string, now = new Date()) {
  const setup = sendingSetup();
  const [co] = await db.select({ email: companies.email, testOf: companies.testOfCompanyId }).from(companies).where(eq(companies.id, companyId));
  const replyDomain = co?.email?.split("@")[1]?.toLowerCase() ?? null;
  const domain = setup.domain ? await checkDomain(setup.domain) : null;

  // This company's customers' (and contacts') addresses.
  const custs = await db.select({ id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, email: customers.email, optOut: customers.emailOptOutAt, delivery: customers.delivery, sample: customers.sample })
    .from(customers).where(and(eq(customers.companyId, companyId), eq(customers.status, "active")));
  const real = custs.filter((c) => !c.sample || co?.testOf);
  const contacts = real.length ? await db.select({ email: customerContacts.email }).from(customerContacts).where(and(inArray(customerContacts.customerId, real.map((c) => c.id)), isNotNull(customerContacts.email))) : [];
  const addresses = [...new Set([...real.map((c) => c.email), ...contacts.map((c) => c.email)].filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()))];

  // What the mail service took (or refused) for them in the last 30 days.
  const since = new Date(now.getTime() - 30 * 86_400_000);
  let sent = 0, failed = 0;
  const failures: { email: string; error: string | null; at: Date; subject: string }[] = [];
  for (let i = 0; i < addresses.length; i += 1000) {
    const chunk = addresses.slice(i, i + 1000);
    const counts = await db.select({ status: emailLog.status, n: sql<number>`count(*)::int` }).from(emailLog).where(and(inArray(emailLog.to, chunk), gte(emailLog.createdAt, since))).groupBy(emailLog.status);
    sent += counts.find((c) => c.status === "sent")?.n ?? 0;
    failed += counts.find((c) => c.status === "failed")?.n ?? 0;
    if (failures.length < 6) failures.push(...(await db.select({ email: emailLog.to, error: emailLog.error, at: emailLog.createdAt, subject: emailLog.subject }).from(emailLog)
      .where(and(inArray(emailLog.to, chunk), eq(emailLog.status, "failed"), gte(emailLog.createdAt, since))).orderBy(desc(emailLog.createdAt)).limit(6)));
  }
  const byEmail = new Map(real.filter((c) => c.email).map((c) => [c.email!.trim().toLowerCase(), c]));

  // Addresses that can't get email: mistyped, a known slip of a big provider, or a domain that takes no mail.
  const problems: AddressProblem[] = [];
  const domains = new Map<string, typeof real>();
  for (const c of real) {
    if (!c.email) continue;
    const e = c.email.trim().toLowerCase();
    if (!VALID.test(e)) { problems.push({ customerId: c.id, name: customerName(c), email: c.email, problem: "Not a complete email address" }); continue; }
    const d = e.split("@")[1];
    if (TYPOS[d]) { problems.push({ customerId: c.id, name: customerName(c), email: c.email, problem: `Probably meant @${TYPOS[d]}` }); continue; }
    if (!KNOWN.has(d)) domains.set(d, [...(domains.get(d) ?? []), c]);
  }
  // Look up at most 60 less common domains per check (results are kept for a day), when DNS works from here.
  const canLook = await dnsWorks();
  for (const [d, cs] of canLook ? [...domains.entries()].slice(0, 60) : []) {
    if ((await domainTakesMail(d)) === false) for (const c of cs) problems.push({ customerId: c.id, name: customerName(c), email: c.email!, problem: `${d} doesn't take email` });
  }
  const emailWanted = (c: (typeof real)[number]) => (c.delivery ?? []).includes("email");
  const noEmail = real.filter((c) => !c.email && emailWanted(c)).length;
  const unsubscribed = real.filter((c) => c.optOut).length;

  const authOk = !!domain && domain.spf.status === "ok" && domain.dkim.status === "ok" && domain.dmarc.status === "ok";
  return {
    setup: { configured: setup.configured, from: setup.from, host: setup.host, replyDomain, mismatch: !!(replyDomain && setup.domain && replyDomain !== setup.domain) },
    domain,
    last30: { sent, failed, failures: failures.slice(0, 6).map((f) => ({ ...f, customer: byEmail.get(f.email) ? { id: byEmail.get(f.email)!.id, name: customerName(byEmail.get(f.email)!) } : null })) },
    addresses: { customers: real.length, withEmail: real.filter((c) => c.email).length, noEmail, unsubscribed, problems: problems.slice(0, 50), problemCount: problems.length },
    dnsChecked: canLook,
    status: !setup.configured ? "off" : !canLook ? "check" : authOk && failed === 0 && problems.length === 0 ? "good" : authOk || (domain?.spf.status === "ok" && domain?.dmarc.status === "ok") ? "check" : "attention",
  };
}

/** Keeps the log to six months. */
export async function pruneEmailLog(now = new Date()) {
  await db.delete(emailLog).where(sql`${emailLog.createdAt} < ${new Date(now.getTime() - 183 * 86_400_000).toISOString()}`);
}
