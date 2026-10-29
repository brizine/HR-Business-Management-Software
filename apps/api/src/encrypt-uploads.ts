/**
 * One-time: encrypts documents uploaded before encryption was added.
 * Safe to run more than once; already-encrypted files are skipped.
 *   pnpm --filter @crewdesk/api encrypt-uploads
 */
import { pool, db } from "./db";
import { documents } from "./db/schema";
import { isEncryptedFile } from "./lib/crypto";
import { blobStore, storage } from "./lib/storage";

let encrypted = 0;
let skipped = 0;
let missing = 0;
for (const doc of await db.select().from(documents)) {
  let raw: Buffer;
  try {
    raw = await blobStore.get(doc.storageKey);
  } catch {
    missing++;
    console.warn(`Missing file for "${doc.name}" (${doc.storageKey})`);
    continue;
  }
  if (isEncryptedFile(raw)) {
    skipped++;
    continue;
  }
  await storage.put(doc.storageKey, raw);
  encrypted++;
}
console.log(`Encrypted ${encrypted} file(s); ${skipped} already encrypted; ${missing} missing.`);
await pool.end();
