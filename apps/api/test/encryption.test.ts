/** Uploaded documents are encrypted at rest; older plain files still open. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { documents } from "../src/db/schema";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { decryptFile, encryptFile, isEncryptedFile } from "../src/lib/crypto";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
let token: string;
const suffix = Date.now();
const uploadDir = resolve(process.env.UPLOAD_DIR ?? "./uploads");
const SECRET_TEXT = "Driver license D1234567, DOB 1990-04-01";

async function upload(content: string, name = "license.txt") {
  const boundary = "----x";
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}`,
    `--${boundary}--\r\n`,
  ].join("\r\n");
  const res = await app.inject({
    method: "POST",
    url: "/documents",
    payload,
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const download = async (id: string) =>
  app.inject({ url: `/documents/${id}/download`, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "t" })) });
  setEmailTransport(null);
  setSmsTransport(null);
  app = await buildApp({ logger: false });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { companyName: "Crypt Co", firstName: "C", lastName: "O", email: `crypt-${suffix}@test.dev`, password: "password123" },
  });
  token = signup.json().token;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("document encryption", () => {
  it("stores ciphertext on disk and returns the original on download", async () => {
    const doc = await upload(SECRET_TEXT);
    const onDisk = await readFile(join(uploadDir, doc.storageKey));
    expect(isEncryptedFile(onDisk)).toBe(true);
    expect(onDisk.toString("latin1")).not.toContain("D1234567");
    expect(doc.sizeBytes).toBe(Buffer.byteLength(SECRET_TEXT));

    const res = await download(doc.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SECRET_TEXT);
  });

  it("rejects an encrypted file swapped in from another document", async () => {
    const a = await upload("Document A");
    const b = await upload("Document B");
    await writeFile(join(uploadDir, b.storageKey), await readFile(join(uploadDir, a.storageKey)));
    expect((await download(b.id)).statusCode).toBe(500);
  });

  it("still opens files saved before encryption", async () => {
    const doc = await upload("placeholder");
    await writeFile(join(uploadDir, doc.storageKey), "Old plain handbook");
    expect((await download(doc.id)).body).toBe("Old plain handbook");
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.storageKey).toBe(doc.storageKey);
  });

  it("uses a different key per file and detects tampering", () => {
    const one = encryptFile(Buffer.from("same"), "k");
    const two = encryptFile(Buffer.from("same"), "k");
    expect(one.equals(two)).toBe(false);
    expect(decryptFile(one, "k").toString()).toBe("same");
    one[one.length - 1] ^= 1;
    expect(() => decryptFile(one, "k")).toThrow();
  });
});
