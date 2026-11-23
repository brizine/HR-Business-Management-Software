import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../db";
import { authenticate, requireRole } from "../lib/auth";
import { customerInCompany } from "../lib/crm";
import { parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { finishSetup, makeDefault, methodView, methodsFor, removeMethod, setAutopay, startSetup } from "../lib/paymentMethods";
import { stripeConfig } from "../lib/stripe";

const AREA = "customers" as const;
const setupId = z.object({ setupIntentId: z.string().regex(/^seti_[A-Za-z0-9]+$/) });

/**
 * A customer's cards and bank accounts on file, from the office (managers in Customers & billing):
 * see them, add a card while on the phone, pick the default, remove one, and turn autopay on or off.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get<{ Params: { id: string } }>("/:id/payment-methods", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    const today = await companyToday(companyId);
    const cfg = await stripeConfig(companyId);
    return { autopay: c.autopay, stripe: cfg ? { mode: cfg.mode } : null, methods: (await methodsFor(c.id)).map((m) => methodView(m, today)) };
  });

  /** Stripe's card form, to save a card the customer reads out (bank accounts need the customer, in the portal). */
  app.post<{ Params: { id: string } }>("/:id/payment-methods/setup", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return startSetup(req.user.companyId, c.id, "office");
  });

  app.post<{ Params: { id: string } }>("/:id/payment-methods/finish", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return finishSetup(req.user.companyId, parse(setupId, req.body).setupIntentId, c.id);
  });

  app.post<{ Params: { id: string; pm: string } }>("/:id/payment-methods/:pm/default", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return makeDefault(req.user.companyId, c.id, req.params.pm);
  });

  app.delete<{ Params: { id: string; pm: string } }>("/:id/payment-methods/:pm", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return removeMethod(req.user.companyId, c.id, req.params.pm);
  });

  app.put<{ Params: { id: string } }>("/:id/autopay", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return setAutopay(req.user.companyId, c.id, parse(z.object({ on: z.boolean() }), req.body).on);
  });
};

export default routes;
