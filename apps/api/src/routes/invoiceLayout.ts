import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { invoiceLayoutSchema } from "@crewdesk/shared";
import { authenticate, requireRole } from "../lib/auth";
import { parse } from "../lib/errors";
import { discardDraft, layoutState, layoutVersion, publishLayout, sampleInvoice, saveDraft } from "../lib/invoiceLayouts";
import { invoicePdf } from "../lib/invoicePdf";
import { companyForPdf, pdfInvoice, sendPdf } from "./invoices";

const layoutBody = z.object({ layout: invoiceLayoutSchema });

/**
 * The invoice layout editor (Settings → Invoice layout), for admins in Customers & billing. The
 * editor's work is a draft until it's published; only the published layout reaches invoices.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("admin", "customers"));

  app.get("/", async (req) => layoutState(req.user.companyId));

  app.put("/draft", async (req) => {
    const { layout } = parse(layoutBody, req.body);
    await saveDraft(req.user.companyId, req.user.sub, layout);
    return layoutState(req.user.companyId);
  });
  app.delete("/draft", async (req) => {
    await discardDraft(req.user.companyId);
    return layoutState(req.user.companyId);
  });
  app.post("/publish", async (req) => {
    const { layout } = parse(layoutBody, req.body);
    await publishLayout(req.user.companyId, req.user.sub, layout);
    return layoutState(req.user.companyId);
  });
  /** An earlier published layout, for the editor to open (nothing changes until it's published again). */
  app.get<{ Params: { id: string } }>("/versions/:id", async (req) => ({ layout: await layoutVersion(req.user.companyId, req.params.id) }));

  /** The invoice as this layout would print it: a real invoice when one is picked, else a made-up one. */
  app.post("/preview", async (req, reply) => {
    const { layout, invoiceId } = parse(layoutBody.extend({ invoiceId: z.string().uuid().nullable().optional() }), req.body);
    const { companyId } = req.user;
    const data = invoiceId ? await pdfInvoice(companyId, invoiceId, { layout }) : await sampleInvoice(companyId, layout);
    return sendPdf(reply, await invoicePdf(await companyForPdf(companyId), data), "invoice-preview.pdf");
  });
};

export default routes;
