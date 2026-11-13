#!/usr/bin/env node
/**
 * Makes the key pair for Crewdesk's encrypted backups. Run it on your own computer (not the server),
 * from the Crewdesk folder:
 *
 *   node scripts/backup-keygen.mjs
 *
 * It saves the private key to crewdesk-backup-private-key.pem (locked with the passphrase you
 * choose) and prints the public key: one short line to paste into BACKUP_PUBLIC_KEY.
 * Needs only Node.js (no install or build).
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const file = resolve(process.argv[2] ?? "crewdesk-backup-private-key.pem");
if (existsSync(file)) {
  console.error(`\n✖ ${file} already exists. Move it somewhere safe first (it opens your existing backups), or give another file name:\n  node scripts/backup-keygen.mjs my-new-key.pem\n`);
  process.exit(1);
}

/** Reads lines without showing what's typed. (Piped input, e.g. for testing, is read all at once.) */
const piped = process.stdin.isTTY ? null : (await new Promise((done) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => done(d)); })).split(/\r?\n/);
const hidden = new Writable({ write(chunk, _enc, cb) { if (!hidden.muted) process.stdout.write(chunk); cb(); } });
const rl = piped ? null : createInterface({ input: process.stdin, output: hidden, terminal: true });
async function secret(prompt) {
  process.stdout.write(prompt);
  if (piped) { process.stdout.write("\n"); return piped.shift() ?? ""; }
  hidden.muted = true;
  const answer = await rl.question("");
  hidden.muted = false;
  process.stdout.write("\n");
  return answer;
}

const passphrase = await secret("Choose a passphrase to protect the private key: ");
if (passphrase.length < 8) {
  console.error("✖ Use at least 8 characters. Nothing was saved.");
  process.exit(1);
}
if ((await secret("Type it again: ")) !== passphrase) {
  console.error("✖ The passphrases didn't match. Nothing was saved.");
  process.exit(1);
}

rl?.close();
const { publicKey, privateKey } = generateKeyPairSync("x25519");
writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }), { mode: 0o600 });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");

console.log(`
✔ Private key saved to ${file}
  Keep it, and the passphrase, somewhere safe and off the server (a password manager, plus a USB
  stick or printout). Without both, backups can't be opened, and nobody can recover them.

Paste this into the server's settings as BACKUP_PUBLIC_KEY:

${pub}
`);
