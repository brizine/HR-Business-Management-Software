import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { customerName, textBodySchema, toE164 } from "@crewdesk/shared";
import { db } from "../db";
import { customerTexts, customers, employees } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { connectTexting, disconnectTexting, markTextsRead, sendCustomerText, textNumberFor, textingConfig, textingProvider } from "../lib/texting";

const AREA = "customers" as const;

/** Texting customers: the connection (Settings → Integrations), conversations, and sending. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get("/settings", async (req) => {
    const cfg = await textingConfig(req.user.companyId);
    return {
      available: textingProvider().ready, connected: !!cfg, provider: "talkroute",
      ...(cfg ? { fromNumber: cfg.fromNumber, connectedAt: cfg.connectedAt, accountName: cfg.accountName } : {}),
    };
  });

  app.put("/settings", { preHandler: requireRole("owner", AREA) }, async (req) => {
    const body = parse(z.object({ apiKey: z.string().trim().min(8, "Paste the API key from Talkroute").max(500), fromNumber: z.string().trim().min(7).max(30) }), req.body);
    await connectTexting(req.user.companyId, body.apiKey, body.fromNumber);
    return { ok: true };
  });

  app.delete("/settings", { preHandler: requireRole("owner", AREA) }, async (req) => {
    await disconnectTexting(req.user.companyId);
    return { ok: true };
  });

  /** Conversations, newest first: the last text with each customer (or unknown number) and how many replies are unread. */
  app.get<{ Querystring: { unread?: string } }>("/conversations", async (req) => {
    const { companyId } = req.user;
    const rows = await db.execute(sql`
      select distinct on (coalesce(t.customer_id::text, t.phone)) t.id, t.customer_id, t.phone, t.body, t.direction, t.status, t.created_at,
        (select count(*)::int from customer_texts u where u.company_id = t.company_id and u.direction = 'in' and u.read_at is null
          and coalesce(u.customer_id::text, u.phone) = coalesce(t.customer_id::text, t.phone)) as unread
      from customer_texts t where t.company_id = ${companyId} and t.source <> 'test'
      order by coalesce(t.customer_id::text, t.phone), t.created_at desc`);
    const list = (rows.rows as any[]).filter((r) => req.query.unread !== "1" || r.unread > 0).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 200);
    const ids = [...new Set(list.map((r) => r.customer_id).filter(Boolean))] as string[];
    const names = new Map((ids.length ? await db.select().from(customers).where(sql`${customers.id} in ${ids}`) : []).map((c) => [c.id, customerName(c)]));
    return {
      unread: list.reduce((n, r) => n + r.unread, 0),
      conversations: list.map((r) => ({ customerId: r.customer_id, name: r.customer_id ? names.get(r.customer_id) ?? "Customer" : null, phone: r.phone, last: { body: r.body, direction: r.direction, status: r.status, at: r.created_at }, unread: r.unread })),
    };
  });

  /** A customer's texts (oldest first); opening them marks their replies read. */
  app.get<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    await markTextsRead(companyId, c.id);
    const texts = await db.select({ t: customerTexts, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(customerTexts)
      .leftJoin(employees, eq(employees.id, customerTexts.sentById))
      .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.customerId, c.id))).orderBy(desc(customerTexts.createdAt)).limit(200);
    const cfg = await textingConfig(companyId);
    return {
      connected: !!cfg, number: textNumberFor(c), optedOut: c.textOptOutAt,
      texts: texts.reverse().map(({ t, by }) => ({ id: t.id, direction: t.direction, body: t.body, status: t.status, error: t.error, source: t.source, by, at: t.createdAt })),
    };
  });

  app.post<{ Params: { id: string } }>("/customers/:id", async (req) => {
    const { body } = parse(textBodySchema, req.body);
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const r = await sendCustomerText(req.user.companyId, c.id, body, { by: req.user.sub, source: "office" });
    if (!r.text) throw new HttpError(400, r.skipped ?? "It couldn't be sent");
    if (r.text.status === "failed") throw new HttpError(502, `It didn't go through: ${r.text.error ?? "the texting service said no"}`);
    return r.text;
  });

  /** Replies from numbers that aren't a customer's: file one under a customer. */
  app.post("/assign", async (req) => {
    const body = parse(z.object({ phone: z.string().max(30), customerId: z.string().uuid() }), req.body);
    const c = await customerInCompany(db, req.user.companyId, body.customerId);
    const phone = toE164(body.phone) ?? body.phone;
    await db.update(customerTexts).set({ customerId: c.id }).where(and(eq(customerTexts.companyId, req.user.companyId), eq(customerTexts.phone, phone), isNull(customerTexts.customerId)));
    return { ok: true };
  });
};

export default routes;
