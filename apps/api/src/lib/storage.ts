import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

/**
 * File storage abstraction. The local-disk implementation is for development;
 * add an S3 / R2 / GCS implementation of this interface for production.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Readable;
}

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
  get(key: string) {
    return createReadStream(this.path(key));
  }
}

export const storage: Storage = new LocalStorage(process.env.UPLOAD_DIR ?? "./uploads");
