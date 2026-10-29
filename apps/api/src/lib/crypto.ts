import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets at rest (authenticator-app secrets) with AES-256-GCM.
 * The key comes from ENCRYPTION_KEY, or JWT_SECRET if that isn't set. Set
 * ENCRYPTION_KEY separately in production: changing the key makes stored
 * secrets unreadable, so everyone would have to set up two-factor again.
 */
function key() {
  const material = process.env.ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "dev-only-secret";
  return Buffer.from(hkdfSync("sha256", material, "crewdesk", "secrets-at-rest-v1", 32));
}

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(stored: string) {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1") throw new Error("Unknown encryption format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** For high-entropy random tokens (reset links, recovery codes), a plain hash is enough. */
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
