import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Where uploaded documents live. */
export interface Storage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Readable>;
}

/**
 * Files on the server's disk. In production, point UPLOAD_DIR outside the
 * deployed code (e.g. /home/customer/crewdesk-uploads on SiteGround) so
 * redeploys don't wipe it, and include that folder in your backups.
 */
export class LocalStorage implements Storage {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return createReadStream(this.path(key));
  }
}

/** Any S3-compatible bucket: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi… */
export class S3Storage implements Storage {
  private client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  constructor(private bucket: string) {}
  async put(key: string, data: Buffer, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }
}

export const storage: Storage = process.env.S3_BUCKET
  ? new S3Storage(process.env.S3_BUCKET)
  : new LocalStorage(process.env.UPLOAD_DIR ?? "./uploads");
