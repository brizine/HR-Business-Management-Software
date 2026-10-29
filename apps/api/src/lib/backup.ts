import { spawn } from "node:child_process";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DATABASE_URL } from "../db";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Encrypted database backups.
 *
 * Each backup gets a fresh AES-256-GCM key, which is itself encrypted with an
 * RSA public key (BACKUP_PUBLIC_KEY). The server only ever has the public key,
 * so it can make backups but can't read them; only whoever holds the private
 * key (kept offline) can. A stolen backup, or a stolen server, doesn't expose
 * the data in old backups.
 *
 * File layout: "CDBAK1\n" | key length (uint16) | RSA-wrapped key | iv (12) | ciphertext | tag (16)
 */

const MAGIC = Buffer.from("CDBAK1\n");
const TAG_LEN = 16;

/** A new RSA-4096 key pair. The public key is one base64 line, easy to paste into a host's settings. */
export function generateBackupKeys(passphrase?: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem", ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}) })
      .toString(),
  };
}

export function loadPublicKey(base64 = process.env.BACKUP_PUBLIC_KEY) {
  if (!base64) throw new Error("BACKUP_PUBLIC_KEY isn't set. Run `pnpm backup:keygen` and add the public key to the server's settings.");
  return createPublicKey({ key: Buffer.from(base64.trim(), "base64"), format: "der", type: "spki" });
}

const wrapKey = (publicKey: KeyObject, key: Buffer) =>
  publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);

/** Encrypts a stream into `outPath`. */
export async function encryptStreamToFile(input: NodeJS.ReadableStream, outPath: string, publicKey: KeyObject) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const wrapped = wrapKey(publicKey, key);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(wrapped.length);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = createWriteStream(outPath, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, header, wrapped, iv]));
  // Append the GCM tag once all the data has gone through.
  const withTag = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, chunk);
    },
    flush(cb) {
      cb(null, cipher.getAuthTag());
    },
  });
  await pipeline(input, cipher, withTag, out);
}

/** Decrypts a backup file with the private key (run on your own computer, not the server). */
export async function decryptFileToFile(inPath: string, outPath: string, privateKeyPem: string, passphrase?: string) {
  const privateKey = createPrivateKey({ key: privateKeyPem, passphrase });
  const { size } = await stat(inPath);
  const fh = await open(inPath, "r");
  try {
    const head = Buffer.alloc(MAGIC.length + 2);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Biz Management Software backup file");
    const wrappedLen = head.readUInt16BE(MAGIC.length);
    const rest = Buffer.alloc(wrappedLen + 12);
    await fh.read(rest, 0, rest.length, head.length);
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);

    const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, rest.subarray(0, wrappedLen));
    const decipher = createDecipheriv("aes-256-gcm", key, rest.subarray(wrappedLen));
    decipher.setAuthTag(tag);
    const start = head.length + rest.length;
    // The tag is checked at the end; a tampered or truncated file throws and the partial output is removed.
    await pipeline(createReadStream(inPath, { start, end: size - TAG_LEN - 1 }), decipher, createWriteStream(outPath, { mode: 0o600 })).catch(
      async (err) => {
        await rm(outPath, { force: true });
        throw new Error(`Backup couldn't be decrypted (wrong key, or the file is damaged): ${err.message}`);
      },
    );
  } finally {
    await fh.close();
  }
}

/** Runs pg_dump (custom format, already compressed) and returns its output stream. */
function dumpDatabase() {
  const child = spawn(process.env.PG_DUMP_PATH ?? "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", DATABASE_URL], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<void>((res, rej) => {
    child.on("error", (err) => rej(new Error(`Couldn't run pg_dump (${err.message}). Set PG_DUMP_PATH if it isn't on the PATH.`)));
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`pg_dump failed: ${stderr.trim()}`))));
  });
  return { stream: child.stdout, done };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP_RE = /^crewdesk-.*\.dump\.enc$/;

/**
 * Makes an encrypted backup and keeps the newest BACKUP_KEEP (default 30).
 * Stored in an S3/R2 bucket under backups/ if S3_BUCKET is set, else BACKUP_DIR.
 */
export async function runBackup() {
  const publicKey = loadPublicKey();
  const dir = resolve(process.env.BACKUP_DIR ?? "./backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `crewdesk-${stamp()}.dump.enc`;
  const path = join(dir, name);

  const dump = dumpDatabase();
  try {
    await Promise.all([encryptStreamToFile(dump.stream, path, publicKey), dump.done]);
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
  const { size } = await stat(path);
  const keep = Number(process.env.BACKUP_KEEP ?? 30);

  if (process.env.S3_BUCKET) {
    const s3 = new S3Client({
      region: process.env.S3_REGION ?? "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
    });
    const Bucket = process.env.S3_BUCKET;
    await s3.send(new PutObjectCommand({ Bucket, Key: `backups/${name}`, Body: createReadStream(path), ContentLength: size }));
    await rm(path);
    const listed = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: "backups/" }));
    const old = (listed.Contents ?? []).map((o) => o.Key!).filter((k) => BACKUP_RE.test(k.slice(8))).sort().reverse().slice(keep);
    for (const Key of old) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    return { name, bytes: size, location: `s3://${Bucket}/backups/${name}`, pruned: old.length };
  }

  const old = (await readdir(dir)).filter((f) => BACKUP_RE.test(f)).sort().reverse().slice(keep);
  for (const f of old) await rm(join(dir, f));
  return { name, bytes: size, location: path, pruned: old.length };
}
