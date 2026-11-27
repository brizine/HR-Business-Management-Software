import { eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { emailTransport, isUndeliverable } from "./channels";
import { companyInfo, messageVars, renderCustomerEmail } from "./customerMessages";
import { sendCustomerText, textingConfig } from "./texting";

/**
 * Telling customers about a visit the way each one asked (their Pre Visit Notification): a text,
 * an email, or a call from the office. Used when work is scheduled, moved to another day, or sent
 * back to the waiting list.
 */

/** Who was told, and who couldn't be. `toCall` are the customers the office should phone. */
export type Told = { texted: number; notTexted: number; emailed: number; notEmailed: number; toCall: string[] };
export const nobodyTold = (): Told => ({ texted: 0, notTexted: 0, emailed: 0, notEmailed: 0, toCall: [] });

/** What to say: one sentence, without the company's name or a sign-off ("we're scheduled for … on Friday."). */
export type VisitNotice = { sentence: string; subject: string };

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A teller for one request. `once`: a customer with several work orders hears about the first only
 * (a day moved for the weather); otherwise each work order gets its own notice.
 */
export function visitTeller(companyId: string, by: string | null, o: { once?: boolean } = {}) {
  const told = nobodyTold();
  const heard = new Set<string>();
  let texting: boolean | null = null;
  let company: Awaited<ReturnType<typeof companyInfo>> | null = null;
  const co = async () => (company ??= await companyInfo(companyId));

  async function email(customerId: string, n: VisitNotice) {
    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId));
    const to = cust?.email?.trim();
    // A service notice (like an invoice): bulk-email unsubscribes don't stop it, but sample customers and dead addresses do.
    if (!cust || cust.companyId !== companyId || cust.sample || !to || isUndeliverable(to) || !emailTransport()) return false;
    const c = await co();
    const vars = (await messageVars(companyId, [cust.id], c)).get(cust.id);
    if (!vars) return false;
    const m = renderCustomerEmail({ company: c, subject: `${c.name}: ${n.subject}`, body: `Hello {first_name},\n\n${capital(n.sentence)}\n\nThank you,\n${c.name}`, vars });
    try {
      await emailTransport()!.send({ to, subject: m.subject, text: m.text, html: m.html, fromName: c.name, replyTo: c.email ?? undefined, track: { companyId, customerId: cust.id, keepBody: true } });
      return true;
    } catch {
      return false;
    }
  }

  return {
    told,
    /** Tells one customer, by the preference given ("text", "email", "call"; anything else: nothing). */
    async tell(pref: string | null | undefined, customer: { id: string; name: string }, n: VisitNotice) {
      if (pref === "call") { if (!told.toCall.includes(customer.name)) told.toCall.push(customer.name); return; }
      if (pref !== "text" && pref !== "email") return;
      if (o.once && heard.has(customer.id)) return;
      heard.add(customer.id);
      if (pref === "email") {
        if (await email(customer.id, n)) told.emailed++; else told.notEmailed++;
        return;
      }
      texting ??= !!(await textingConfig(companyId));
      if (!texting) { told.notTexted++; return; }
      const s = await sendCustomerText(companyId, customer.id, `${(await co()).name}: ${n.sentence} Reply STOP to opt out.`, { by, source: "office" });
      if (s.text && s.text.status !== "failed") told.texted++; else told.notTexted++;
    },
  };
}
