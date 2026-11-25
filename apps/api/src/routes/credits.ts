import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { applyCreditSchema, creditSchema, formatAddress, voidCreditSchema } from "@crewdesk/shared";
import { db } from "../db";
import { accountingPostings, creditApplications, customerCredits, employees, invoices, properties, propertyAssignments } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { customerInCompany } from "../lib/crm";
import { companyToday } from "../lib/payRates";
import { applyCredit, autoApplyCredits, creditLeft, nextCreditNumber, removeApplication, voidCredit } from "../lib/credits";
import { queueBillingSync, syncCredit } from "../lib/billingSync";

const AREA = "customers" as const;

/** A customer's credits with where each was used, what's left, and how it stands in Bigcapital. */
export async function creditsFor(companyId: string, customerId: string) {
  const list = await db.select({ c: customerCredits, propStreet: properties.street, propCity: properties.city, propState: properties.state, propZip: properties.zip, by: employees.firstName, byLast: employees.lastName })
    .from(customerCredits).leftJoin(properties, eq(properties.id, customerCredits.propertyId)).leftJoin(employees, eq(employees.id, customerCredits.createdById))
    .where(and(eq(customerCredits.companyId, companyId), eq(customerCredits.customerId, customerId))).orderBy(desc(customerCredits.issuedOn), desc(customerCredits.number));
  const ids = list.map((r) => r.c.id);
  const apps = ids.length ? await db.select({ a: creditApplications, number: invoices.number }).from(creditApplications).innerJoin(invoices, eq(invoices.id, creditApplications.invoiceId))
    .where(and(inArray(creditApplications.creditId, ids), isNull(creditApplications.removedAt))).orderBy(asc(creditApplications.createdAt), asc(invoices.dueDate), asc(invoices.number)) : [];
  const posts = ids.length ? await db.select().from(accountingPostings).where(and(eq(accountingPostings.companyId, companyId), eq(accountingPostings.kind, "credit"), inArray(accountingPostings.sourceId, ids))) : [];
  const credits = list.map(({ c, propStreet, propCity, propState, propZip, by, byLast }) => ({
    ...c, leftCents: creditLeft(c),
    property: c.propertyId ? { id: c.propertyId, address: formatAddress({ street: propStreet, city: propCity, state: propState, zip: propZip }) } : null,
    createdBy: by ? `${by} ${byLast ?? ""}`.trim() : null,
    applications: apps.filter((x) => x.a.creditId === c.id).map((x) => ({ id: x.a.id, invoiceId: x.a.invoiceId, invoiceNumber: x.number, amountCents: x.a.amountCents, appliedOn: x.a.appliedOn })),
    books: (() => { const p = posts.find((x) => x.sourceId === c.id); return p ? { status: p.status, error: p.error } : null; })(),
  }));
  return { credits, availableCents: credits.filter((c) => !c.prepaymentId).reduce((s, c) => s + c.leftCents, 0) };
}

/** Customer credits: add, use on invoices, take off, void. Managers in Customers & billing. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get<{ Querystring: { customerId?: string } }>("/", async (req) => {
    if (!req.query.customerId) throw new HttpError(400, "Choose a customer");
    await customerInCompany(db, req.user.companyId, req.query.customerId);
    return creditsFor(req.user.companyId, req.query.customerId);
  });

  /** Adds a credit, and uses it on one invoice, on open invoices now, or keeps it for the next invoice. */
  app.post("/", async (req) => {
    const body = parse(creditSchema, req.body);
    const { companyId, sub } = req.user;
    await customerInCompany(db, companyId, body.customerId);
    if (body.propertyId) {
      const [link] = await db.select({ id: propertyAssignments.id }).from(propertyAssignments)
        .where(and(eq(propertyAssignments.propertyId, body.propertyId), eq(propertyAssignments.customerId, body.customerId), eq(propertyAssignments.companyId, companyId)));
      if (!link) throw new HttpError(400, "That property isn't one of this customer's");
    }
    const credit = await db.transaction(async (tx) => {
      const [c] = await tx.insert(customerCredits).values({
        companyId, number: await nextCreditNumber(tx, companyId), customerId: body.customerId, propertyId: body.propertyId ?? null, amountCents: body.amountCents,
        reason: body.reason, description: body.description, note: body.note ?? null, issuedOn: await companyToday(companyId), createdById: sub,
      }).returning();
      if (body.applyTo === "open") await autoApplyCredits(tx, companyId, body.customerId, { creditIds: [c.id], by: sub });
      else if (body.applyTo !== "none") await applyCredit(tx, companyId, c.id, body.applyTo, undefined, sub);
      return c;
    });
    queueBillingSync(() => syncCredit(companyId, credit.id, sub));
    return (await creditsFor(companyId, body.customerId)).credits.find((c) => c.id === credit.id);
  });

  app.post<{ Params: { id: string } }>("/:id/apply", async (req) => {
    const body = parse(applyCreditSchema, req.body);
    const { companyId, sub } = req.user;
    const a = await db.transaction((tx) => applyCredit(tx, companyId, req.params.id, body.invoiceId, body.amountCents, sub));
    queueBillingSync(() => syncCredit(companyId, a.creditId, sub));
    return a;
  });

  /** Takes credit off an invoice; it goes back on the customer's account. */
  app.post<{ Params: { applicationId: string } }>("/applications/:applicationId/remove", async (req) => {
    const { companyId, sub } = req.user;
    const a = await db.transaction((tx) => removeApplication(tx, companyId, req.params.applicationId));
    queueBillingSync(() => syncCredit(companyId, a.creditId, sub));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/:id/void", async (req) => {
    const { reason } = parse(voidCreditSchema, req.body);
    const { companyId, sub } = req.user;
    const c = await db.transaction((tx) => voidCredit(tx, companyId, req.params.id, reason));
    queueBillingSync(() => syncCredit(companyId, c.id, sub));
    return c;
  });

  /** "Send to Bigcapital now" for one credit. */
  app.post<{ Params: { id: string } }>("/:id/sync", async (req) => {
    const [c] = await db.select({ id: customerCredits.id }).from(customerCredits).where(and(eq(customerCredits.id, req.params.id), eq(customerCredits.companyId, req.user.companyId)));
    if (!c) throw new HttpError(404, "Credit not found");
    const r = await syncCredit(req.user.companyId, c.id, req.user.sub);
    if (r === "not_connected") throw new HttpError(400, "Bigcapital isn't connected (Settings → Integrations)");
    return { result: r };
  });
};

export default routes;
