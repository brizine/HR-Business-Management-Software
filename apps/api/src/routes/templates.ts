import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  allActions,
  MESSAGE_KINDS, MESSAGE_KIND_NEEDS, SAMPLE_TEMPLATE_VARS, customerName, fillTags, formatMoney, htmlToText, smsSegments, systemTemplate, tagNeeds,
  templateDefaultsSchema, templateImportSchema, templatePreviewSchema, templateSchema, unknownTags,
  type MessageKind, type TemplateChannel,
} from "@crewdesk/shared";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { automations, companies, customers, emailImages, emailLog, employees, estimates, invoicePayments, invoices, templates, visits } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { PUBLIC_API_URL, emailTransport } from "../lib/channels";
import { HttpError, parse } from "../lib/errors";
import { MAX_IMAGE_BYTES } from "../lib/images";
import { storage } from "../lib/storage";
import { cleanEmailHtml, designedTemplate, ensureSystemTemplates, importTemplates, renderTemplateEmail, templateDefaults, templateDesign, templateVars, type TemplateRow } from "../lib/templates";

/** Pictures for emails: the kinds every email program shows (no WebP: Outlook can't). */
function emailImageType(b: Buffer) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

const AREA = "customers" as const;
const view = (t: TemplateRow, usedFor: MessageKind[] = []) => ({
  id: t.id, channel: t.channel as TemplateChannel, audience: t.audience, name: t.name, subject: t.subject, body: t.body,
  system: !!t.systemKey, systemKey: t.systemKey, imported: t.importedFrom?.split(":")[0] ?? null, updatedAt: t.updatedAt, designed: !!t.design,
  needs: tagNeeds(t.subject, t.body), usedFor,
});

/** Marketing → Templates: the email and text template library, previews, the defaults and the Sent / History. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const usage = async (companyId: string) => {
    const d = await templateDefaults(companyId);
    const m = new Map<string, MessageKind[]>();
    for (const k of MESSAGE_KINDS) for (const id of [d[k].email, d[k].text]) if (id) m.set(id, [...(m.get(id) ?? []), k]);
    return m;
  };
  const find = async (companyId: string, id: string) => {
    const [t] = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.companyId, companyId)));
    if (!t) throw new HttpError(404, "Template not found");
    return t;
  };
  const cleanBody = (channel: TemplateChannel, body: string) => (channel === "email" ? cleanEmailHtml(body) : body.replace(/\r/g, "").trim());

  app.get("/", async (req) => {
    const { companyId } = req.user;
    await ensureSystemTemplates(companyId);
    const used = await usage(companyId);
    const rows = await db.select().from(templates).where(eq(templates.companyId, companyId)).orderBy(templates.name);
    return rows.map((t) => view(t, used.get(t.id)));
  });

  /** One template; an email comes with its design for the builder (an earlier plain one is turned into blocks). */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const t = await find(req.user.companyId, req.params.id);
    return { ...view(t, (await usage(req.user.companyId)).get(req.params.id)), design: t.channel === "email" ? await templateDesign(t) : null };
  });

  /** An email saved from the builder is kept as its design, with the email HTML made from it here (never taken from the browser). */
  const content = (channel: TemplateChannel, b: { body: string; design?: Parameters<typeof designedTemplate>[0] | null }) =>
    channel === "email" && b.design ? designedTemplate(b.design) : { design: null, body: cleanBody(channel, b.body) };

  app.post("/", async (req) => {
    const b = parse(templateSchema, req.body);
    const [t] = await db.insert(templates).values({
      companyId: req.user.companyId, channel: b.channel, audience: b.audience, name: b.name, subject: b.channel === "email" ? b.subject ?? null : null,
      ...content(b.channel, b), createdById: req.user.sub, updatedById: req.user.sub,
    }).returning();
    return view(t);
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const b = parse(templateSchema, req.body);
    const t = await find(req.user.companyId, req.params.id);
    if (b.channel !== t.channel) throw new HttpError(400, "A template can't change between email and text; make a new one");
    const [u] = await db.update(templates).set({
      audience: b.audience, name: t.systemKey ? t.name : b.name, subject: t.channel === "email" ? b.subject ?? null : null, ...content(t.channel as TemplateChannel, b),
      updatedById: req.user.sub, updatedAt: new Date(),
    }).where(eq(templates.id, t.id)).returning();
    return view(u, (await usage(req.user.companyId)).get(u.id));
  });

  app.post<{ Params: { id: string } }>("/:id/clone", async (req) => {
    const t = await find(req.user.companyId, req.params.id);
    const [c] = await db.insert(templates).values({
      companyId: t.companyId, channel: t.channel, audience: t.audience, name: `Copy - ${t.name}`.slice(0, 120), subject: t.subject, body: t.body, design: t.design,
      createdById: req.user.sub, updatedById: req.user.sub,
    }).returning();
    return view(c);
  });

  /** Crewdesk's own templates go back to their original wording. */
  app.post<{ Params: { id: string } }>("/:id/reset", async (req) => {
    const t = await find(req.user.companyId, req.params.id);
    const s = t.systemKey ? systemTemplate(t.systemKey) : null;
    if (!s) throw new HttpError(400, "Only Crewdesk's own templates can be reset");
    const [u] = await db.update(templates).set({ name: s.name, subject: s.subject ?? null, body: s.body, design: null, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(templates.id, t.id)).returning();
    return view(u, (await usage(req.user.companyId)).get(u.id));
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const t = await find(req.user.companyId, req.params.id);
    if (t.systemKey) throw new HttpError(400, "Crewdesk's own templates can't be deleted; change the wording, or reset it");
    const used = (await usage(req.user.companyId)).get(t.id);
    if (used?.length) throw new HttpError(400, `It's what goes out with ${used.map((k) => k).join(" and ")}. Pick another template for that first (Defaults tab)`);
    const autos = (await db.select({ name: automations.name, def: automations.def }).from(automations).where(eq(automations.companyId, req.user.companyId)))
      .filter((a) => allActions(a.def).some((x) => x.templateId === t.id));
    if (autos.length) throw new HttpError(400, `It's used by ${autos.slice(0, 3).map((a) => `"${a.name}"`).join(", ")}${autos.length > 3 ? ` and ${autos.length - 3} more` : ""}. Change those automations first`);
    await db.delete(templates).where(eq(templates.id, t.id));
    return { ok: true };
  });

  /** A template as typed, filled in for a customer (and an invoice, estimate…), or with example values. */
  app.post("/preview", async (req) => {
    const b = parse(templatePreviewSchema, req.body);
    const { companyId } = req.user;
    const ctx = { customerId: b.customerId, invoiceId: b.invoiceId, estimateId: b.estimateId, visitId: b.visitId, paymentId: b.paymentId };
    const vars = ctx.customerId || ctx.invoiceId || ctx.estimateId || ctx.visitId || ctx.paymentId ? await templateVars(companyId, ctx) : { ...SAMPLE_TEMPLATE_VARS, ...(await templateVars(companyId, {})) };
    const needs = tagNeeds(b.subject, b.body);
    const missing = needs.filter((n) => !(n === "invoice" ? ctx.invoiceId : n === "estimate" ? ctx.estimateId : n === "visit" ? ctx.visitId : ctx.paymentId));
    const sample = !ctx.customerId && !ctx.invoiceId && !ctx.estimateId && !ctx.visitId && !ctx.paymentId;
    if (b.channel === "text") {
      const text = fillTags(b.body, sample ? { ...vars, ...Object.fromEntries(Object.entries(SAMPLE_TEMPLATE_VARS).filter(([k]) => !vars[k])) } : vars).trim();
      return { channel: "text", text, segments: smsSegments(text), unknown: unknownTags(b.body), needs, missing: sample ? [] : missing, sample };
    }
    const body = b.design ? designedTemplate(b.design).body : cleanEmailHtml(b.body);
    const m = await renderTemplateEmail(companyId, { subject: b.subject ?? "", body }, sample ? { ...SAMPLE_TEMPLATE_VARS, ...vars } : vars);
    return { channel: "email", subject: m.subject, html: m.html, text: m.text, unknown: unknownTags(b.subject, body), needs: tagNeeds(b.subject, body), missing: sample ? [] : tagNeeds(b.subject, body).filter((n) => !(n === "invoice" ? ctx.invoiceId : n === "estimate" ? ctx.estimateId : n === "visit" ? ctx.visitId : ctx.paymentId)), sample };
  });

  /** Sends the email to yourself, filled in like the preview. */
  app.post("/test", async (req) => {
    const b = parse(templatePreviewSchema, req.body);
    if (b.channel !== "email") throw new HttpError(400, "Test sends are for emails; a text's preview shows exactly what goes out");
    const transport = emailTransport();
    if (!transport) throw new HttpError(400, "Email isn't set up on this server yet");
    const [me] = await db.select({ email: employees.email }).from(employees).where(eq(employees.id, req.user.sub));
    const { companyId } = req.user;
    const ctx = { customerId: b.customerId, invoiceId: b.invoiceId, estimateId: b.estimateId, visitId: b.visitId, paymentId: b.paymentId };
    const sample = !Object.values(ctx).some(Boolean);
    const vars = sample ? { ...SAMPLE_TEMPLATE_VARS, ...(await templateVars(companyId, {})) } : await templateVars(companyId, ctx);
    const m = await renderTemplateEmail(companyId, { subject: b.subject ?? "", body: b.design ? designedTemplate(b.design).body : cleanEmailHtml(b.body) }, vars);
    const to = b.to ?? me.email;
    await transport.send({ to, subject: `[Test] ${m.subject}`, text: m.text, html: m.html, fromName: m.fromName, replyTo: m.replyTo });
    return { to };
  });

  /** A picture for an email (JPEG, PNG or GIF, up to 5 MB): saved, and served to whoever opens the email. */
  app.post("/images", async (req) => {
    const file = await req.file();
    if (!file) throw new HttpError(400, "No picture uploaded");
    const buf = await file.toBuffer();
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, "That picture is too large (5 MB max)");
    const contentType = emailImageType(buf);
    if (!contentType) throw new HttpError(400, "Use a JPEG, PNG or GIF picture (email programs don't all show other kinds)");
    const key = `${req.user.companyId}/email-images/${randomUUID()}`;
    await storage.put(key, buf);
    const [row] = await db.insert(emailImages).values({ companyId: req.user.companyId, key, contentType, bytes: buf.length, name: file.filename?.slice(0, 200) ?? null, createdById: req.user.sub }).returning({ id: emailImages.id });
    return { id: row.id, url: `${PUBLIC_API_URL}/public/email-image/${row.id}` };
  });

  /** For the preview: the customer's recent invoices, estimates, work orders and payments to fill tags from. */
  app.get<{ Querystring: { customerId?: string } }>("/context", async (req) => {
    const id = req.query.customerId;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return { invoices: [], estimates: [], visits: [], payments: [] };
    const { companyId } = req.user;
    const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
    if (!c) throw new HttpError(404, "Customer not found");
    const inv = await db.select({ id: invoices.id, number: invoices.number, totalCents: invoices.totalCents, status: invoices.status, issueDate: invoices.issueDate }).from(invoices)
      .where(eq(invoices.customerId, id)).orderBy(desc(invoices.createdAt)).limit(10);
    const est = await db.select({ id: estimates.id, number: estimates.number, title: estimates.title, totalCents: estimates.totalCents, status: estimates.status }).from(estimates)
      .where(eq(estimates.customerId, id)).orderBy(desc(estimates.createdAt)).limit(10);
    const vis = await db.select({ id: visits.id, number: visits.number, title: visits.title, date: visits.date }).from(visits)
      .where(eq(visits.customerId, id)).orderBy(desc(sql`coalesce(${visits.date}, '9999-12-31')`)).limit(10);
    const pay = await db.select({ id: invoicePayments.id, amountCents: invoicePayments.amountCents, receivedOn: invoicePayments.receivedOn, method: invoicePayments.method }).from(invoicePayments)
      .where(eq(invoicePayments.customerId, id)).orderBy(desc(invoicePayments.receivedOn)).limit(10);
    return {
      invoices: inv.map((x) => ({ id: x.id, label: `Invoice ${x.number ?? "(draft)"} · ${formatMoney(x.totalCents)} · ${x.status}` })),
      estimates: est.map((x) => ({ id: x.id, label: `Estimate ${x.number}${x.title ? ` · ${x.title}` : ""} · ${formatMoney(x.totalCents)}` })),
      visits: vis.map((x) => ({ id: x.id, label: `WO-${x.number} · ${x.title}${x.date ? ` · ${x.date}` : " · waitlist"}` })),
      payments: pay.map((x) => ({ id: x.id, label: `${formatMoney(x.amountCents)} · ${x.receivedOn} · ${x.method}` })),
    };
  });

  /* ── Defaults: what goes out with invoices, estimates and receipts ── */

  app.get("/defaults/current", async (req) => templateDefaults(req.user.companyId));

  app.put("/defaults/current", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const b = parse(templateDefaultsSchema, req.body);
    const { companyId } = req.user;
    const ids = MESSAGE_KINDS.flatMap((k) => [b[k].email, b[k].text]).filter((x): x is string => !!x);
    const rows = ids.length ? await db.select().from(templates).where(and(eq(templates.companyId, companyId), inArray(templates.id, ids))) : [];
    for (const k of MESSAGE_KINDS) {
      for (const ch of ["email", "text"] as const) {
        const id = b[k][ch];
        if (!id) continue;
        const t = rows.find((r) => r.id === id);
        if (!t || t.channel !== ch) throw new HttpError(400, `Pick an ${ch} template for ${k}s`);
        const wrong = tagNeeds(t.subject, t.body).filter((n) => !MESSAGE_KIND_NEEDS[k].includes(n));
        if (wrong.length) throw new HttpError(400, `"${t.name}" uses ${wrong.join(" and ")} details, which ${k}s don't have`);
      }
    }
    await db.update(companies).set({ templateDefaults: b }).where(eq(companies.id, companyId));
    return templateDefaults(companyId);
  });

  /* ── Import (Homeworks) ── */

  app.post("/import", { preHandler: requireRole("admin", AREA), bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const b = parse(templateImportSchema, req.body);
    return importTemplates(req.user.companyId, req.user.sub, b.source, b.templates);
  });

  /* ── Sent / History ── */

  app.get<{ Querystring: { q?: string; status?: string; templateId?: string; before?: string } }>("/history/list", async (req) => {
    const { companyId } = req.user;
    const where = [eq(emailLog.companyId, companyId)];
    if (req.query.status === "failed") where.push(eq(emailLog.status, "failed"));
    if (req.query.status === "opened") where.push(sql`${emailLog.openCount} > 0`);
    if (req.query.status === "unopened") where.push(and(eq(emailLog.status, "sent"), eq(emailLog.openCount, 0))!);
    if (req.query.templateId && /^[0-9a-f-]{36}$/i.test(req.query.templateId)) where.push(eq(emailLog.templateId, req.query.templateId));
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) where.push(lt(emailLog.createdAt, new Date(req.query.before)));
    if (req.query.q?.trim()) { const q = `%${req.query.q.trim()}%`; where.push(or(ilike(emailLog.to, q), ilike(emailLog.subject, q))!); }
    const rows = await db.select({ l: emailLog, c: customers, tName: templates.name }).from(emailLog)
      .leftJoin(customers, eq(customers.id, emailLog.customerId)).leftJoin(templates, eq(templates.id, emailLog.templateId))
      .where(and(...where)).orderBy(desc(emailLog.createdAt)).limit(100);
    return rows.map(({ l, c, tName }) => ({
      id: l.id, to: l.to, subject: l.subject, status: l.status, error: l.error, sentAt: l.createdAt, openedAt: l.openedAt, lastOpenedAt: l.lastOpenedAt, openCount: l.openCount,
      customer: c ? { id: c.id, name: customerName(c) } : null, template: l.templateId ? { id: l.templateId, name: tName ?? "(deleted template)" } : null, hasBody: !!l.body,
    }));
  });

  app.get<{ Params: { id: string } }>("/history/:id", async (req) => {
    const [l] = await db.select().from(emailLog).where(and(eq(emailLog.id, req.params.id), eq(emailLog.companyId, req.user.companyId)));
    if (!l) throw new HttpError(404, "Email not found");
    return { id: l.id, to: l.to, subject: l.subject, body: l.body, status: l.status, error: l.error, sentAt: l.createdAt, openedAt: l.openedAt, openCount: l.openCount };
  });
};

/** Pictures in emails (no sign-in: whoever gets the email sees them). */
export const emailImageRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "Not found" });
    const [img] = await db.select().from(emailImages).where(eq(emailImages.id, req.params.id));
    if (!img) return reply.code(404).send({ error: "Not found" });
    const buf = await storage.get(img.key);
    reply.header("Content-Type", emailImageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
  });
};

export default routes;

/** The 1×1 image in template emails: counts an open. Public (mail apps load it). */
export const trackRoutes: FastifyPluginAsync = async (app) => {
  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  app.get<{ Params: { file: string } }>("/o/:file", async (req, reply) => {
    const id = req.params.file.replace(/\.gif$/, "");
    if (z.string().uuid().safeParse(id).success) {
      await db.update(emailLog).set({ openCount: sql`${emailLog.openCount} + 1`, openedAt: sql`coalesce(${emailLog.openedAt}, now())`, lastOpenedAt: new Date() })
        .where(eq(emailLog.id, id)).catch(() => {});
    }
    return reply.header("content-type", "image/gif").header("cache-control", "no-store, max-age=0").send(GIF);
  });
};
