import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { VISIT_FILE_MAX_BYTES, VISIT_FILE_TYPES } from "@crewdesk/shared";
import { HttpError } from "./errors";
import { storage } from "./storage";

/** One stored photo or document (work order and to-do files share this shape). */
export interface StoredFile {
  id: string; fileName: string; contentType: string; sizeBytes: number; storageKey: string; caption: string | null;
  uploadedById: string | null; createdAt: Date;
}

export const fileView = (f: StoredFile, by?: string | null) => ({
  id: f.id, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes, caption: f.caption, uploadedById: f.uploadedById, uploadedBy: by ?? null, createdAt: f.createdAt,
});

/**
 * Reads a multipart upload ("file": a photo, PDF or short video up to 25 MB, and an optional
 * "caption" sent before it) and stores it encrypted under `<company>/<folder>/<id>/`.
 */
export async function storeUpload(req: FastifyRequest, folder: string, parentId: string) {
  const file = await req.file();
  if (!file) throw new HttpError(400, "No file uploaded");
  if (!(VISIT_FILE_TYPES as readonly string[]).includes(file.mimetype)) throw new HttpError(400, "Upload a photo (JPG, PNG, HEIC, WebP, GIF), a PDF, or a video (MP4 or MOV)");
  let buf: Buffer;
  try { buf = await file.toBuffer(); } catch { throw new HttpError(400, "That file is over 25 MB"); }
  if (buf.length > VISIT_FILE_MAX_BYTES || file.file.truncated) throw new HttpError(400, "That file is over 25 MB");
  const captionField = file.fields?.caption as { value?: unknown } | undefined;
  const caption = typeof captionField?.value === "string" ? captionField.value.trim().slice(0, 300) || null : null;
  const fileName = (file.filename || "file").replace(/[^\w.\- ]/g, "_").slice(0, 120);
  const storageKey = `${req.user.companyId}/${folder}/${parentId}/${randomUUID()}-${fileName.replace(/\s+/g, "_")}`;
  await storage.put(storageKey, buf);
  return { fileName, contentType: file.mimetype, sizeBytes: buf.length, storageKey, caption };
}

/** Sends a stored file to view in the browser, or (download) to save. */
export async function sendStored(reply: FastifyReply, f: StoredFile, download: boolean) {
  reply.header("Content-Type", f.contentType);
  reply.header("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${f.fileName.replace(/"/g, "")}"`);
  reply.header("Cache-Control", "private, max-age=3600");
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.send(await storage.get(f.storageKey));
}
