/** Encrypted backups: only the private key opens them; tampering and wrong keys fail. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { decryptFileToFile, encryptStreamToFile, generateBackupKeys, loadPublicKey, runBackup } from "../src/lib/backup";

let dir: string;
const keys = generateBackupKeys("correct horse");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crewdesk-backup-"));
  process.env.BACKUP_DIR = dir;
  process.env.BACKUP_PUBLIC_KEY = keys.publicKey;
});

afterAll(async () => {
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_PUBLIC_KEY;
  await rm(dir, { recursive: true, force: true });
  await pool.end();
});

describe("encrypted backups", () => {
  it("backs up the database so only the private key can read it", async () => {
    const result = await runBackup();
    const raw = await readFile(result.location);
    expect(raw.subarray(0, 7).toString()).toBe("CDBAK2\n");
    expect(raw.includes(Buffer.from("PGDMP"))).toBe(false); // the dump itself isn't visible

    const out = join(dir, "restored.dump");
    await decryptFileToFile(result.location, out, keys.privateKeyPem, "correct horse");
    expect((await readFile(out)).subarray(0, 5).toString()).toBe("PGDMP");
    // pg_restore can read it, and it contains Crewdesk's tables.
    const listing = execFileSync("pg_restore", ["--list", out]).toString();
    expect(listing).toContain("TABLE public employees");
  }, 30_000);

  it("the public key is short enough for any host's settings form", () => {
    expect(keys.publicKey.length).toBeLessThanOrEqual(64);
    expect(loadPublicKey(keys.publicKey).asymmetricKeyType).toBe("x25519");
  });

  it("still reads and writes backups for older RSA keys", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = rsa.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const path = join(dir, "rsa.enc");
    await encryptStreamToFile(Readable.from([Buffer.from("old style")]), path, loadPublicKey(pub));
    expect((await readFile(path)).subarray(0, 7).toString()).toBe("CDBAK1\n");
    await decryptFileToFile(path, join(dir, "rsa.out"), rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect((await readFile(join(dir, "rsa.out"))).toString()).toBe("old style");
  });

  it("fails with the wrong key, the wrong passphrase, or a tampered file", async () => {
    const path = join(dir, "sample.enc");
    await encryptStreamToFile(Readable.from([Buffer.from("payroll data")]), path, loadPublicKey());
    const other = generateBackupKeys();
    await expect(decryptFileToFile(path, join(dir, "x"), other.privateKeyPem)).rejects.toThrow();
    await expect(decryptFileToFile(path, join(dir, "x"), keys.privateKeyPem, "wrong")).rejects.toThrow();

    const bytes = await readFile(path);
    bytes[bytes.length - 20] ^= 1;
    await writeFile(path + ".bad", bytes);
    await expect(decryptFileToFile(path + ".bad", join(dir, "bad.out"), keys.privateKeyPem, "correct horse")).rejects.toThrow(/couldn't be decrypted/);
    expect((await readdir(dir)).includes("bad.out")).toBe(false); // no partial output left behind
  });

  it("keeps only the newest BACKUP_KEEP backups", async () => {
    process.env.BACKUP_KEEP = "2";
    for (let i = 0; i < 3; i++) {
      await runBackup();
      await new Promise((r) => setTimeout(r, 1100)); // names are per-second
    }
    expect((await readdir(dir)).filter((f) => f.endsWith(".dump.enc"))).toHaveLength(2);
    delete process.env.BACKUP_KEEP;
  }, 30_000);

  it("refuses to run without a public key (never writes unencrypted backups)", async () => {
    const saved = process.env.BACKUP_PUBLIC_KEY;
    delete process.env.BACKUP_PUBLIC_KEY;
    await expect(runBackup()).rejects.toThrow(/BACKUP_PUBLIC_KEY/);
    process.env.BACKUP_PUBLIC_KEY = saved;
  });

  it("the cron endpoint needs the jobs secret", async () => {
    process.env.JOBS_SECRET = "backup-secret-for-tests";
    const app = await buildApp({ logger: false });
    expect((await app.inject({ method: "POST", url: "/jobs/backup" })).statusCode).toBe(404);
    const ok = await app.inject({ method: "POST", url: "/jobs/backup", headers: { "x-jobs-secret": "backup-secret-for-tests" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toMatch(/^crewdesk-.*\.dump\.enc$/);
    await app.close();
    delete process.env.JOBS_SECRET;
  }, 30_000);
});
