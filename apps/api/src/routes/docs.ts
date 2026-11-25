import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { DOC_PRINT_MAX, customerName, docCustomersSchema, docEmailSchema, docImportSchema, docPreviewSchema, docPrintSchema, docSchema, formatPhone, unknownTags } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customers, marketingDocTemplates, marketingDocs } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { PUBLIC_API_URL, emailTransport } from "../lib/channels";
import { docAudience, docHistory, docHistoryList, docLetters, emailDoc, importDocTemplates, letterCompany, pdfFileName, previewDoc } from "../lib/docs";
import { lettersPdf } from "../lib/docPdf";
import { HttpError, parse } from "../lib/errors";
import { companyLines } from "../lib/invoicePdf";
import { cleanEmailHtml } from "../lib/templates";
import { parseSelection, selectedIds } from "./customers";

const AREA = "customers" as const;

/**
 * Marketing → Documents (like Homeworks): documents and document templates with fill-ins, the
 * letterhead, a document's history, and emailing or printing it for chosen customers.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const findDoc = async (companyId: string, id: string) => {
    const [d] = await db.select().from(marketingDocs).where(and(eq(marketingDocs.id, id), eq(marketingDocs.companyId, companyId)));
    if (!d) throw new HttpError(404, "Document not found");
    return d;
  };
  const findTemplate = async (companyId: string, id: string) => {
    const [t] = await db.select().from(marketingDocTemplates).where(and(eq(marketingDocTemplates.id, id), eq(marketingDocTemplates.companyId, companyId)));
    if (!t) throw new HttpError(404, "Template not found");
    return t;
  };
  /**
   * Who it's for: the customers picked one by one in the pop-ups (`customerIds`), or a list from
   * the Customers page (the ticked ones, or everyone the list matches).
   */
  const customerIdsFor = async (companyId: string, body: unknown) => {
    const raw = (body ?? {}) as Record<string, unknown>;
    return raw.match || raw.ids ? selectedIds(companyId, parseSelection(raw)) : parse(docCustomersSchema, raw).customerIds;
  };
  /** Cleaned content, and any {{WORDS}} that aren't fill-ins (probably typos). */
  const cleaned = (content: string) => { const c = cleanEmailHtml(content); return { content: c, unknown: unknownTags(c) }; };

  /* ── Document templates ── */

  app.get("/templates", async (req) => {
    const rows = await db.select({ id: marketingDocTemplates.id, name: marketingDocTemplates.name, importedFrom: marketingDocTemplates.importedFrom })
      .from(marketingDocTemplates).where(eq(marketingDocTemplates.companyId, req.user.companyId)).orderBy(sql`lower(${marketingDocTemplates.name})`);
    return rows.map((t) => ({ id: t.id, name: t.name, imported: t.importedFrom?.split(":")[0] ?? null }));
  });

  app.get<{ Params: { id: string } }>("/templates/:id", async (req) => {
    const t = await findTemplate(req.user.companyId, req.params.id);
    return { id: t.id, name: t.name, content: t.content };
  });

  app.post("/templates", async (req) => {
    const b = parse(docSchema, req.body);
    const c = cleaned(b.content);
    const [t] = await db.insert(marketingDocTemplates).values({ companyId: req.user.companyId, name: b.name, content: c.content, createdById: req.user.sub, updatedById: req.user.sub }).returning();
    return { id: t.id, name: t.name, content: t.content, unknown: c.unknown };
  });

  app.put<{ Params: { id: string } }>("/templates/:id", async (req) => {
    const b = parse(docSchema, req.body);
    const t = await findTemplate(req.user.companyId, req.params.id);
    const c = cleaned(b.content);
    await db.update(marketingDocTemplates).set({ name: b.name, content: c.content, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(marketingDocTemplates.id, t.id));
    return { id: t.id, name: b.name, content: c.content, unknown: c.unknown };
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", async (req) => {
    const t = await findTemplate(req.user.companyId, req.params.id);
    await db.delete(marketingDocTemplates).where(eq(marketingDocTemplates.id, t.id));
    return { ok: true };
  });

  /* ── What the pop-ups and the header need ── */

  /** The letterhead every document is printed on. */
  app.get("/letterhead", async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return {
      name: c.name, lines: companyLines(c), phone: c.phone ? formatPhone(c.phone) : null, email: c.email, website: c.website,
      logoUrl: c.logoKey ? `${PUBLIC_API_URL}/public/company/${c.id}/logo` : null,
    };
  });

  /** "Select Customers": by name or email. */
  app.get<{ Querystring: { q?: string } }>("/customers", async (req) => {
    const q = (req.query.q ?? "").trim();
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    const rows = await db.select({
      id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, email: customers.email,
      optedOut: sql<boolean>`${customers.emailOptOutAt} is not null`, sample: customers.sample,
    }).from(customers)
      .where(and(
        eq(customers.companyId, req.user.companyId),
        q ? or(
          ilike(customers.email, like), ilike(customers.companyName, like),
          and(...words.map((w) => { const l = `%${w.replace(/[%_\\]/g, "\\$&")}%`; return or(ilike(customers.firstName, l), ilike(customers.lastName, l), ilike(customers.companyName, l)); })),
        ) : undefined,
      ))
      // By the name shown (a business by its company name, a person by first then last name).
      .orderBy(sql`lower(case when coalesce(${customers.companyName}, '') <> '' and (${customers.kind} <> 'residential' or coalesce(${customers.firstName}, '') || coalesce(${customers.lastName}, '') = '')
        then ${customers.companyName} else trim(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) end)`, customers.number).limit(50);
    return rows.map((c) => ({ id: c.id, name: customerName(c), email: c.email?.trim() || null, optedOut: c.optedOut, sample: c.sample }));
  });

  /* ── Documents ── */

  app.get("/", async (req) => {
    return db.select({ id: marketingDocs.id, name: marketingDocs.name }).from(marketingDocs).where(eq(marketingDocs.companyId, req.user.companyId)).orderBy(sql`lower(${marketingDocs.name})`, asc(marketingDocs.createdAt));
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const d = await findDoc(req.user.companyId, req.params.id);
    return { id: d.id, name: d.name, content: d.content };
  });

  app.post("/", async (req) => {
    const b = parse(docSchema, req.body);
    const c = cleaned(b.content);
    const [d] = await db.insert(marketingDocs).values({ companyId: req.user.companyId, name: b.name, content: c.content, createdById: req.user.sub, updatedById: req.user.sub }).returning();
    await docHistory(req.user.companyId, d.id, "created", req.user.sub);
    return { id: d.id, name: d.name, content: d.content, unknown: c.unknown };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const b = parse(docSchema, req.body);
    const d = await findDoc(req.user.companyId, req.params.id);
    const c = cleaned(b.content);
    await db.update(marketingDocs).set({ name: b.name, content: c.content, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(marketingDocs.id, d.id));
    await docHistory(req.user.companyId, d.id, "updated", req.user.sub);
    return { id: d.id, name: b.name, content: c.content, unknown: c.unknown };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const d = await findDoc(req.user.companyId, req.params.id);
    await db.delete(marketingDocs).where(eq(marketingDocs.id, d.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/:id/history", async (req) => {
    const d = await findDoc(req.user.companyId, req.params.id);
    return docHistoryList(d.id);
  });

  /** Before sending to a list: how many an email reaches, who it can't (and why), and who to show the preview for. */
  app.post<{ Params: { id: string } }>("/:id/audience", async (req) => {
    const { companyId } = req.user;
    await findDoc(companyId, req.params.id);
    const a = await docAudience(companyId, await customerIdsFor(companyId, req.body));
    const first = a.going[0] ?? a.people[0] ?? null;
    return {
      total: a.people.length, sending: a.going.length, skipped: a.skipped, byMail: a.byMail.length, emailReady: !!emailTransport(),
      first: first ? { id: first.customerId, name: first.name } : null,
    };
  });

  /** The document as one customer will get it: the email and the printed letter. */
  app.post<{ Params: { id: string } }>("/:id/preview", async (req) => {
    const b = parse(docPreviewSchema, req.body);
    const d = await findDoc(req.user.companyId, req.params.id);
    return previewDoc(req.user.companyId, d, b.customerId, b.emailTemplateId);
  });

  /** One PDF: the document as a letter for each chosen customer (or only those an email can't reach). */
  app.post<{ Params: { id: string } }>("/:id/print", async (req, reply) => {
    const { companyId } = req.user;
    const o = parse(docPrintSchema, req.body ?? {});
    const d = await findDoc(companyId, req.params.id);
    let ids = await customerIdsFor(companyId, req.body);
    if (o.only === "notEmailed") ids = (await docAudience(companyId, ids)).byMail.map((p) => p.customerId);
    if (ids.length > DOC_PRINT_MAX) throw new HttpError(400, `That's more than ${DOC_PRINT_MAX.toLocaleString()} letters in one PDF. Narrow the list and print it in parts.`);
    const letters = await docLetters(companyId, d.content, ids);
    if (!letters.length) throw new HttpError(400, o.only === "notEmailed" ? "Everyone on this list can be emailed, so there are no letters to print" : "Please select at least one customer");
    const pdf = await lettersPdf(await letterCompany(companyId), letters, { title: d.name });
    if (!o.preview) await docHistory(companyId, d.id, "printed", req.user.sub, { customers: letters.length });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${pdfFileName(d.name).replace(/"/g, "")}"`).send(Buffer.from(pdf));
  });

  /** Emails the document to each chosen customer. */
  app.post<{ Params: { id: string } }>("/:id/email", async (req) => {
    const { companyId } = req.user;
    const b = parse(docEmailSchema, req.body ?? {});
    const d = await findDoc(companyId, req.params.id);
    return emailDoc({ companyId, by: req.user.sub, doc: d, customerIds: await customerIdsFor(companyId, req.body), emailTemplateId: b.emailTemplateId, attachPdf: b.attachPdf, audience: b.audience ?? null });
  });

  /* ── Homeworks import ── */

  app.post("/import", { preHandler: requireRole("admin", AREA), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const body = req.body as { documentTemplates?: unknown } | null;
    if (body && typeof body === "object" && !Array.isArray(body) && !("documentTemplates" in body)) throw new HttpError(400, "This file has no document templates. Use the Homeworks documents file.");
    const b = parse(docImportSchema, req.body);
    return importDocTemplates(req.user.companyId, req.user.sub, b.source, b.documentTemplates);
  });
};

export default routes;
