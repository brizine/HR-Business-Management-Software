import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest with AES-256-GCM. Keys are derived from ENCRYPTION_KEY
 * (or JWT_SECRET if that isn't set). Set ENCRYPTION_KEY separately in
 * production and never change it: data encrypted with the old key, such as
 * two-factor secrets and uploaded documents, can't be read with a new one.
 */
function masterKey() {
  return process.env.ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "dev-only-secret";
}

function key(purpose = "secrets-at-rest-v1", salt: Buffer | string = "crewdesk") {
  return Buffer.from(hkdfSync("sha256", masterKey(), salt, purpose, 32));
}

/**
 * `purpose` gives each kind of data its own derived key (two-factor secrets
 * use the default; tax forms use "tax-forms-v1").
 */
export function encrypt(plain: string, purpose?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(stored: string, purpose?: string) {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1") throw new Error("Unknown encryption format");
  const decipher = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** For high-entropy random tokens (reset links, recovery codes), a plain hash is enough. */
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// ---- Files ----

/** Marks an encrypted file; files without it are from before encryption and are read as-is. */
const FILE_MAGIC = Buffer.from("CDENC1");

export const isEncryptedFile = (buf: Buffer) => buf.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);

/**
 * Encrypts a file with its own key (derived from the master key and a random
 * salt). `bindTo` (the storage key) is authenticated, so an encrypted file
 * can't be swapped in for another document's.
 * Layout: magic(6) | salt(16) | iv(12) | tag(16) | ciphertext
 */
export function encryptFile(plain: Buffer, bindTo: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("documents-v1", salt), iv);
  cipher.setAAD(Buffer.from(bindTo));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, salt, iv, cipher.getAuthTag(), data]);
}

export function decryptFile(stored: Buffer, bindTo: string) {
  if (!isEncryptedFile(stored)) return stored;
  let o = FILE_MAGIC.length;
  const salt = stored.subarray(o, (o += 16));
  const iv = stored.subarray(o, (o += 12));
  const tag = stored.subarray(o, (o += 16));
  const decipher = createDecipheriv("aes-256-gcm", key("documents-v1", salt), iv);
  decipher.setAAD(Buffer.from(bindTo));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(o)), decipher.final()]);
}
