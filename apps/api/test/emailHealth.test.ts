/** Email deliverability: the send log, the sending domain's SPF/DKIM/DMARC, and customer addresses that can't get email. Pretend DNS. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { customers, emailLog } from "../src/db/schema";
import { emailTransport, setEmailTransport } from "../src/lib/channels";
import { setDnsResolver } from "../src/lib/emailHealth";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@health.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const saved = { from: process.env.EMAIL_FROM, smtp: process.env.SMTP_URL };
const notFound = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  process.env.EMAIL_FROM = "ProSpray <office@prospray-health.test>";
  process.env.SMTP_URL = "smtp://mailer:s3cret-pass@smtp.mailservice.test:587";
  setDnsResolver({
    async resolveTxt(name) {
      const recs: Record<string, string[][]> = {
        "prospray-health.test": [["v=spf1 include:_spf.mailservice.test ~all"], ["google-site-verification=abc"]],
        "_dmarc.prospray-health.test": [["v=DMARC1; p=quarantine; rua=mailto:dmarc@prospray-health.test"]],
        "s1._domainkey.prospray-health.test": [["v=DKIM1; k=rsa; ", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"]],
      };
      if (recs[name]) return recs[name];
      throw notFound();
    },
    async resolveMx(name) {
      if (name === `goodlawn-${suffix}.test` || name === "health.test" || name === "gmail.com") return [{ exchange: "mx.goodlawn.test", priority: 10 }];
      throw notFound();
    },
    async resolve4() { throw notFound(); },
  });
  setEmailTransport({ send: async (m) => { if (m.to.startsWith("dee-")) throw new Error("550 5.1.1 Mailbox unavailable"); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Health Co", firstName: "Hal", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Health Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@prospray-health.test", timezone: "America/Chicago" });
  const mk = async (first: string, addr: string) => (await call("POST", "/customers", "owner", { firstName: first, lastName: "Lawn", email: addr })).body.id as string;
  ID.ann = await mk("Ann", email("ann"));
  ID.bob = await mk("Bob", `bob${suffix}@gmial.com`);
  ID.cal = await mk("Cal", `cal@deadlawn-${suffix}.test`);
  ID.dee = await mk("Dee", `dee-${suffix}@goodlawn-${suffix}.test`);
  await db.update(customers).set({ emailOptOutAt: new Date() }).where(eq(customers.id, ID.ann));
});

afterAll(async () => {
  setDnsResolver(null);
  setEmailTransport(null);
  process.env.EMAIL_FROM = saved.from; process.env.SMTP_URL = saved.smtp;
  if (!saved.from) delete process.env.EMAIL_FROM;
  if (!saved.smtp) delete process.env.SMTP_URL;
  await app.close();
  await pool.end();
});

describe("email deliverability", () => {
  it("every send is noted, sent or refused (and a refusal still reaches the caller)", async () => {
    await emailTransport()!.send({ to: email("ann"), subject: "Your invoice", text: "x", html: "x" });
    await expect(emailTransport()!.send({ to: `dee-${suffix}@goodlawn-${suffix}.test`, subject: "Your estimate", text: "x", html: "x" })).rejects.toThrow(/Mailbox unavailable/);
    const rows = await db.select().from(emailLog).where(eq(emailLog.to, `dee-${suffix}@goodlawn-${suffix}.test`));
    expect(rows[0]).toMatchObject({ status: "failed", subject: "Your estimate" });
    expect(rows[0].error).toMatch(/550/);
  });

  it("the box: sending setup, the last 30 days, and addresses that can't get email", async () => {
    const r = await call("GET", "/my-day/email", "owner");
    expect(r.status).toBe(200);
    const h = r.body;
    expect(JSON.stringify(h)).not.toContain("s3cret-pass");
    expect(h.setup).toMatchObject({ configured: true, from: "office@prospray-health.test", host: "smtp.mailservice.test", mismatch: false });
    expect(h.domain).toMatchObject({ domain: "prospray-health.test", spf: { status: "ok" }, dkim: { status: "ok", selector: "s1" }, dmarc: { status: "ok", policy: "quarantine" } });
    expect(h.last30).toMatchObject({ sent: 1, failed: 1 });
    expect(h.last30.failures[0]).toMatchObject({ subject: "Your estimate", customer: { name: "Dee Lawn" } });
    expect(h.addresses).toMatchObject({ customers: 4, withEmail: 4, unsubscribed: 1, problemCount: 2 });
    const probs = Object.fromEntries(h.addresses.problems.map((p: any) => [p.name, p.problem]));
    expect(probs["Bob Lawn"]).toBe("Probably meant @gmail.com");
    expect(probs["Cal Lawn"]).toMatch(/doesn't take email/);
    expect(h.status).toBe("check");
  });

  it("missing records show up", async () => {
    process.env.EMAIL_FROM = "Crew <hello@bare-domain.test>";
    const noData = () => Object.assign(new Error("no data"), { code: "ENODATA" });
    setDnsResolver({ async resolveTxt() { throw noData(); }, async resolveMx(n) { if (n === "gmail.com") return [{ exchange: "mx", priority: 1 }]; throw noData(); }, async resolve4() { return ["192.0.2.1"]; } });
    const h = (await call("GET", "/my-day/email", "owner")).body;
    expect(h.domain).toMatchObject({ spf: { status: "missing" }, dmarc: { status: "missing" }, dkim: { status: "not_found" } });
    expect(h.setup.mismatch).toBe(true);
    expect(h.status).toBe("attention");
  });

  it("when DNS doesn't work from the server, it says it couldn't check rather than \"missing\"", async () => {
    setDnsResolver({ async resolveTxt() { throw notFound(); }, async resolveMx() { throw notFound(); }, async resolve4() { throw notFound(); } });
    const h = (await call("GET", "/my-day/email", "owner")).body;
    expect(h.dnsChecked).toBe(false);
    expect(h.domain).toMatchObject({ spf: { status: "unknown" }, dkim: { status: "unknown" }, dmarc: { status: "unknown" } });
    expect(h.addresses.problems.some((p: any) => /doesn't take email/.test(p.problem))).toBe(false);
    expect(h.status).toBe("check");
  });
});
