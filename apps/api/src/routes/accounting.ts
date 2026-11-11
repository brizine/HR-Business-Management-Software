import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accountingSettingsSchema } from "@crewdesk/shared";
import { db } from "../db";
import { accountingPostings, assets, companies, payPeriods, workOrders } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { encrypt } from "../lib/crypto";
import { bigcapital, BigcapitalError } from "../lib/bigcapital";
import { ACCOUNTING_KEY_PURPOSE, accountingConfig, clientFor, postPayPeriod, postWorkOrder } from "../lib/accounting";

/** Accounting sits with payroll: payroll admins see and send; the owner (payroll settings) connects. */
const AREA = "payroll" as const;

/** Bigcapital problems become a 400 carrying the message (it's useful to whoever pressed the button). */
async function asHttp<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BigcapitalError) throw new HttpError(400, e.message);
    throw e;
  }
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("admin", AREA));

  app.get("/settings", async (req) => {
    const { settings, hasKey } = await accountingConfig(req.user.companyId);
    return { ...settings, hasKey };
  });

  /** Saves the connection and account choices. A blank API key keeps the saved one. */
  app.put("/settings", { preHandler: requireRole("owner", AREA) }, async (req) => {
    const { apiKey, ...settings } = parse(accountingSettingsSchema, req.body);
    const current = await accountingConfig(req.user.companyId);
    if (settings.enabled && !apiKey && !current.hasKey) throw new HttpError(400, "Paste a Bigcapital API key to connect");
    await db.update(companies).set({ accounting: settings, ...(apiKey ? { accountingKey: encrypt(apiKey, ACCOUNTING_KEY_PURPOSE) } : {}) }).where(eq(companies.id, req.user.companyId));
    return { ...settings, hasKey: !!apiKey || current.hasKey };
  });

  /** Tries the address and key (the typed key, or the saved one) and returns Bigcapital's accounts. */
  app.post("/test", { preHandler: requireRole("owner", AREA) }, async (req) => {
    const body = parse(z.object({ baseUrl: accountingSettingsSchema.shape.baseUrl, apiKey: z.string().trim().max(500).optional() }), req.body);
    const key = body.apiKey || (await accountingConfig(req.user.companyId)).key;
    if (!key) throw new HttpError(400, "Paste a Bigcapital API key to test");
    const accounts = await asHttp(() => bigcapital(body.baseUrl, key).accounts());
    return { ok: true, accounts: accounts.filter((a) => a.active) };
  });

  /** Bigcapital's chart of accounts, for choosing where things go. */
  app.get("/accounts", async (req) => asHttp(async () => (await (await clientFor(req.user.companyId)).bc.accounts()).filter((a) => a.active)));

  /**
   * What's been sent and what's waiting: recent approved pay periods and completed work orders with
   * costs, each with its posting (if any).
   */
  app.get("/status", async (req) => {
    const { settings, hasKey } = await accountingConfig(req.user.companyId);
    const periods = await db.select().from(payPeriods).where(and(eq(payPeriods.companyId, req.user.companyId), eq(payPeriods.status, "approved"))).orderBy(desc(payPeriods.periodStart)).limit(12);
    const orders = await db.select({ wo: workOrders, assetName: assets.name }).from(workOrders).innerJoin(assets, eq(assets.id, workOrders.assetId))
      .where(and(eq(workOrders.companyId, req.user.companyId), eq(workOrders.status, "completed"), isNotNull(workOrders.completedAt), gt(sql`${workOrders.partsCostCents} + ${workOrders.laborCostCents}`, 0)))
      .orderBy(desc(workOrders.completedAt)).limit(30);
    const ids = [...periods.map((p) => p.id), ...orders.map((o) => o.wo.id)];
    const posts = ids.length ? await db.select().from(accountingPostings).where(and(eq(accountingPostings.companyId, req.user.companyId), inArray(accountingPostings.sourceId, ids))) : [];
    const postFor = (kind: string, id: string) => posts.find((p) => p.kind === kind && p.sourceId === id) ?? null;
    return {
      connected: settings.enabled && hasKey && !!settings.baseUrl,
      baseUrl: settings.baseUrl || null,
      payroll: periods.map((p) => {
        const post = postFor("payroll", p.id);
        // Reopened and approved again after it was sent: the journal may be out of date.
        return { id: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, payday: p.payday, posting: post, changedSincePosting: !!post && post.status === "posted" && !!p.approvedAt && p.approvedAt > post.updatedAt };
      }),
      workOrders: orders.map(({ wo, assetName }) => {
        const post = postFor("work_order", wo.id);
        const total = wo.partsCostCents + wo.laborCostCents;
        return { id: wo.id, number: wo.number, title: wo.title, assetName, completedAt: wo.completedAt, totalCents: total, posting: post, changedSincePosting: !!post && post.status === "posted" && post.amountCents !== total };
      }),
    };
  });

  app.post<{ Params: { id: string } }>("/payroll/:id", async (req) => asHttp(() => postPayPeriod(req.user.companyId, req.params.id, req.user.sub)));
  app.post<{ Params: { id: string } }>("/work-orders/:id", async (req) => asHttp(() => postWorkOrder(req.user.companyId, req.params.id, req.user.sub)));
};

export default routes;
