import { spawn } from "node:child_process";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
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
import { folderPath } from "./paths";

/**
 * Encrypted database backups.
 *
 * Each backup gets a fresh AES-256-GCM key, derived for one public key
 * (BACKUP_PUBLIC_KEY). The server only ever has the public key, so it can make
 * backups but can't read them; only whoever holds the private key (kept
 * offline) can. A stolen backup, or a stolen server, doesn't expose the data in
 * old backups.
 *
 * Keys are X25519 (the public key is 60 characters, short enough for any host's
 * settings form). Older RSA keys still work.
 *
 * X25519 file: "CDBAK2\n" | one-time public key (32) | iv (12) | ciphertext | tag (16)
 *   AES key = HKDF-SHA256(X25519(one-time private, recipient public), salt = one-time public | recipient public)
 * RSA file:    "CDBAK1\n" | key length (uint16) | RSA-OAEP-wrapped key | iv (12) | ciphertext | tag (16)
 */

const MAGIC = Buffer.from("CDBAK1\n");
const MAGIC2 = Buffer.from("CDBAK2\n");
const TAG_LEN = 16;
const INFO = Buffer.from("crewdesk-backup-v2");
/** The DER header in front of a raw 32-byte X25519 public key (SubjectPublicKeyInfo). */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const rawX25519 = (key: KeyObject) => key.export({ type: "spki", format: "der" }).subarray(-32);
const x25519FromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
const deriveKey = (shared: Buffer, oneTime: Buffer, recipient: Buffer) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([oneTime, recipient]), INFO, 32));

/** A new X25519 key pair. The public key is one short base64 line, easy to paste into a host's settings. */
export function generateBackupKeys(passphrase?: string) {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem", ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}) })
      .toString(),
  };
}

export function loadPublicKey(base64 = process.env.BACKUP_PUBLIC_KEY) {
  if (!base64) throw new Error("BACKUP_PUBLIC_KEY isn't set. Run `pnpm backup:keygen` and add the public key to the server's settings.");
  const key = createPublicKey({ key: Buffer.from(base64.trim(), "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519" && key.asymmetricKeyType !== "rsa") throw new Error("BACKUP_PUBLIC_KEY must be an X25519 (or RSA) public key. Make one with `node scripts/backup-keygen.mjs`.");
  return key;
}

const wrapKey = (publicKey: KeyObject, key: Buffer) =>
  publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);

/** Encrypts a stream into `outPath`. */
export async function encryptStreamToFile(input: NodeJS.ReadableStream, outPath: string, publicKey: KeyObject) {
  const iv = randomBytes(12);
  let key: Buffer;
  let head: Buffer;
  if (publicKey.asymmetricKeyType === "x25519") {
    const oneTime = generateKeyPairSync("x25519");
    const oneTimeRaw = rawX25519(oneTime.publicKey);
    key = deriveKey(diffieHellman({ privateKey: oneTime.privateKey, publicKey }), oneTimeRaw, rawX25519(publicKey));
    head = Buffer.concat([MAGIC2, oneTimeRaw, iv]);
  } else {
    key = randomBytes(32);
    const wrapped = wrapKey(publicKey, key);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(wrapped.length);
    head = Buffer.concat([MAGIC, len, wrapped, iv]);
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = createWriteStream(outPath, { mode: 0o600 });
  out.write(head);
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
    const magic = Buffer.alloc(MAGIC.length);
    await fh.read(magic, 0, magic.length, 0);
    let key: Buffer;
    let iv: Buffer;
    let start: number;
    if (magic.equals(MAGIC2)) {
      const rest = Buffer.alloc(32 + 12);
      await fh.read(rest, 0, rest.length, magic.length);
      const oneTimeRaw = rest.subarray(0, 32);
      const recipient = createPublicKey(privateKey);
      if (recipient.asymmetricKeyType !== "x25519") throw new Error("This backup needs the newer (X25519) private key");
      key = deriveKey(diffieHellman({ privateKey, publicKey: x25519FromRaw(oneTimeRaw) }), oneTimeRaw, rawX25519(recipient));
      iv = rest.subarray(32);
      start = magic.length + rest.length;
    } else if (magic.equals(MAGIC)) {
      const len = Buffer.alloc(2);
      await fh.read(len, 0, 2, magic.length);
      const wrappedLen = len.readUInt16BE(0);
      const rest = Buffer.alloc(wrappedLen + 12);
      await fh.read(rest, 0, rest.length, magic.length + 2);
      key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, rest.subarray(0, wrappedLen));
      iv = rest.subarray(wrappedLen);
      start = magic.length + 2 + rest.length;
    } else {
      throw new Error("Not a Crewdesk backup file");
    }
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
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
  const dir = folderPath(process.env.BACKUP_DIR ?? "./backups");
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
