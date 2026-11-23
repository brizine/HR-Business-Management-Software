import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "../lib/auth";
import { parse } from "../lib/errors";
import { WEB_URL } from "../lib/channels";
import { connectStripe, disconnectStripe, recordPaymentIntent, stripeConfig, syncRefunds, verifyWebhook } from "../lib/stripe";
import { finishSetup, methodDetached } from "../lib/paymentMethods";

const AREA = "customers" as const;
/** Where Stripe can reach this API (for the webhook); set PUBLIC_API_URL if it isn't WEB_URL + /api. */
const publicApiUrl = () => (process.env.PUBLIC_API_URL ?? `${WEB_URL}/api`).replace(/\/$/, "");

/** Stripe settings (Settings → Integrations): owners connect their keys; admins see the status. */
export const stripeSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const cfg = await stripeConfig(req.user.companyId);
    if (!cfg) return { connected: false };
    return { connected: true, mode: cfg.mode, publishableKey: cfg.publishableKey, accountName: cfg.accountName ?? null, webhook: !!cfg.webhookSecret, connectedAt: cfg.connectedAt ?? null, isTestCompany: cfg.isTestCompany };
  });

  app.put("/settings", { preHandler: requireRole("owner", AREA) }, async (req) => {
    const body = parse(z.object({ publishableKey: z.string().trim().min(10).max(300), secretKey: z.string().trim().min(10).max(300) }), req.body);
    return connectStripe(req.user.companyId, body.publishableKey, body.secretKey, publicApiUrl());
  });

  app.delete("/settings", { preHandler: requireRole("owner", AREA) }, async (req) => {
    await disconnectStripe(req.user.companyId);
    return { ok: true };
  });
};

/**
 * Stripe's webhook: tells Crewdesk a payment succeeded, is on its way (bank) or failed. Checked
 * against the company's webhook signing secret; the raw body is needed for that.
 */
export const stripeWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post<{ Params: { companyId: string } }>("/webhook/:companyId", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.companyId)) return reply.status(404).send({ error: "Not found" });
    const event = await verifyWebhook(req.params.companyId, req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
    if (event.type.startsWith("payment_intent.")) {
      const pi = event.data.object as { id: string };
      await recordPaymentIntent(req.params.companyId, pi.id);
    } else if (event.type === "charge.refunded" || event.type.startsWith("refund.") || event.type === "charge.refund.updated") {
      // A refund made in Crewdesk or in Stripe's dashboard: read the payment's refunds back from Stripe.
      const obj = event.data.object as { payment_intent?: string | { id: string } | null };
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      if (pi) await syncRefunds(req.params.companyId, pi);
    } else if (event.type === "setup_intent.succeeded") {
      // A card or bank account saved in the portal (in case the browser didn't get back to say so).
      const si = event.data.object as { id: string; metadata?: Record<string, string> };
      if (si.metadata?.crewdeskCustomerId) await finishSetup(req.params.companyId, si.id).catch(() => undefined);
    } else if (event.type === "payment_method.detached") {
      await methodDetached(req.params.companyId, (event.data.object as { id: string }).id);
    }
    return { received: true };
  });
};
