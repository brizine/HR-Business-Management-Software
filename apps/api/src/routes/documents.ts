import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { documents } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { storage } from "../lib/storage";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Managers see everything; employees see company-wide docs and their own. */
  app.get<{ Querystring: { employeeId?: string; assetId?: string } }>("/", async (req) => {
    const { companyId, sub } = req.user;
    const filters = [eq(documents.companyId, companyId)];
    if (req.query.employeeId) filters.push(eq(documents.employeeId, req.query.employeeId));
    if (req.query.assetId) filters.push(eq(documents.assetId, req.query.assetId));
    if (!isManager(req)) filters.push(or(eq(documents.employeeId, sub), isNull(documents.employeeId))!);
    return db
      .select()
      .from(documents)
      .where(and(...filters))
      .orderBy(desc(documents.createdAt));
  });

  /**
   * multipart/form-data upload. Fields: file, name?, category?, employeeId?,
   * assetId?, requiresSignature?. Employees may only upload to their own file.
   */
  app.post("/", async (req) => {
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded");
    const field = (n: string) => {
      const f = file.fields[n] as { value?: string } | undefined;
      return f?.value || undefined;
    };
    let employeeId = field("employeeId") ?? null;
    if (!isManager(req)) employeeId = req.user.sub;

    const buf = await file.toBuffer();
    const key = `${req.user.companyId}/${randomUUID()}-${file.filename.replace(/[^\w.-]/g, "_")}`;
    await storage.put(key, buf);

    const [row] = await db
      .insert(documents)
      .values({
        companyId: req.user.companyId,
        employeeId,
        assetId: field("assetId") ?? null,
        name: field("name") ?? file.filename,
        category: field("category") ?? "general",
        storageKey: key,
        mimeType: file.mimetype,
        sizeBytes: buf.length,
        requiresSignature: field("requiresSignature") === "true",
        uploadedById: req.user.sub,
      })
      .returning();
    return row;
  });

  async function loadVisible(req: { user: { companyId: string; sub: string; role: string } }, id: string) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.companyId, req.user.companyId)));
    if (!doc) notFound("Document");
    if (!isManager(req as never) && doc.employeeId && doc.employeeId !== req.user.sub) notFound("Document");
    return doc;
  }

  app.get<{ Params: { id: string } }>("/:id/download", async (req, reply) => {
    const doc = await loadVisible(req, req.params.id);
    reply.header("Content-Type", doc.mimeType);
    reply.header("Content-Disposition", `attachment; filename="${doc.name.replace(/"/g, "")}"`);
    return reply.send(storage.get(doc.storageKey));
  });

  /**
   * Records a typed-name e-signature with timestamp and IP. For legally
   * stronger signing (audit trail PDFs), integrate a provider like Dropbox Sign.
   */
  app.post<{ Params: { id: string } }>("/:id/sign", async (req) => {
    const { signedName } = parse(z.object({ signedName: z.string().min(2) }), req.body);
    const doc = await loadVisible(req, req.params.id);
    if (!doc.requiresSignature) throw new HttpError(400, "This document does not require a signature");
    if (doc.employeeId !== req.user.sub) throw new HttpError(403, "Only the assigned employee can sign");
    if (doc.signedAt) throw new HttpError(409, "Already signed");
    const [row] = await db
      .update(documents)
      .set({ signedAt: new Date(), signedName, signedIp: req.ip })
      .where(eq(documents.id, doc.id))
      .returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    if (!isManager(req)) throw new HttpError(403, "Only managers can delete documents");
    const [row] = await db
      .delete(documents)
      .where(and(eq(documents.id, req.params.id), eq(documents.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Document");
    return { ok: true };
  });
};

export default routes;
