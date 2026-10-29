/**
 * Backup commands (run from the repo root):
 *   pnpm backup:keygen                        make a key pair (once; keep the private key offline)
 *   pnpm backup:run                           make an encrypted backup now (needs DATABASE_URL, BACKUP_PUBLIC_KEY)
 *   pnpm backup:decrypt <file.enc> [key.pem]  decrypt a backup, then restore it with pg_restore
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { decryptFileToFile, generateBackupKeys, runBackup } from "./lib/backup";

/** Reads a line without echoing it (for passphrases). */
async function secret(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => write(s.startsWith(prompt) ? s : "");
  const answer = await rl.question(prompt);
  rl.close();
  process.stdout.write("\n");
  return answer;
}

const [command, ...args] = process.argv.slice(2);

if (command === "keygen") {
  const passphrase = process.env.BACKUP_PASSPHRASE ?? (await secret("Passphrase to protect the private key (recommended; Enter for none): "));
  if (passphrase && !process.env.BACKUP_PASSPHRASE && (await secret("Type it again: ")) !== passphrase) {
    console.error("Passphrases didn't match.");
    process.exit(1);
  }
  const { publicKey, privateKeyPem } = generateBackupKeys(passphrase || undefined);
  const file = args[0] ?? "crewdesk-backup-private-key.pem";
  await writeFile(file, privateKeyPem, { mode: 0o600 });
  console.log(`
Private key saved to ${file}.
  • Keep it OFF the server: a password manager, an encrypted USB drive, or a printed copy in a safe.
  • Without it (and its passphrase) backups can't be opened. Nobody can recover it for you.

Add this to the server's environment variables as BACKUP_PUBLIC_KEY:

${publicKey}
`);
} else if (command === "run") {
  const result = await runBackup();
  console.log(`Backup saved: ${result.location} (${(result.bytes / 1024).toFixed(0)} KB); removed ${result.pruned} old backup(s).`);
} else if (command === "decrypt") {
  const [input, keyFile = "crewdesk-backup-private-key.pem"] = args;
  if (!input) {
    console.error("Usage: pnpm backup:decrypt <backup.dump.enc> [private-key.pem]");
    process.exit(1);
  }
  const pem = await readFile(keyFile, "utf8");
  const passphrase = pem.includes("ENCRYPTED") ? (process.env.BACKUP_PASSPHRASE ?? (await secret("Private key passphrase: "))) : undefined;
  const output = input.replace(/\.enc$/, "");
  await decryptFileToFile(input, output, pem, passphrase);
  console.log(`Decrypted to ${output}. Restore it into an empty database with:\n  pg_restore --no-owner -d "postgres://USER:PASSWORD@HOST:5432/DATABASE" ${output}`);
} else {
  console.log("Usage: backup-cli keygen | run | decrypt <file> [key.pem]");
  process.exit(command ? 1 : 0);
}
process.exit(0);
