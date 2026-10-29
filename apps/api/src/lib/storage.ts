import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { decryptFile, encryptFile } from "./crypto";

/** Raw byte storage for uploaded documents (encryption is layered on top; see `storage` below). */
export interface BlobStore {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/**
 * Files on the server's disk. In production, point UPLOAD_DIR outside the
 * deployed code (e.g. /home/customer/crewdesk-uploads on SiteGround) so
 * redeploys don't wipe it, and include that folder in your backups.
 */
export class LocalStore implements BlobStore {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + "/")) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
}

/** Any S3-compatible bucket: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi… */
export class S3Store implements BlobStore {
  private client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  constructor(private bucket: string, private prefix = "") {}
  async put(key: string, data: Buffer) {
    // Content is encrypted, so it's always stored as opaque bytes.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefix + key, Body: data, ContentType: "application/octet-stream" }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
}

export const blobStore: BlobStore = process.env.S3_BUCKET
  ? new S3Store(process.env.S3_BUCKET)
  : new LocalStore(process.env.UPLOAD_DIR ?? "./uploads");

/**
 * Uploaded documents, encrypted before they leave the app (AES-256-GCM, one
 * key per file). A copied upload folder or a leaked bucket is unreadable
 * without ENCRYPTION_KEY. Files saved before encryption existed still open.
 */
export const storage = {
  async put(key: string, data: Buffer) {
    await blobStore.put(key, encryptFile(data, key));
  },
  async get(key: string) {
    return decryptFile(await blobStore.get(key), key);
  },
};
