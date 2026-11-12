/**
 * What `pnpm start` / `npm start` runs in production. Before starting Crewdesk (main.ts) it:
 *   - copies everything Crewdesk prints into a log file (~/crewdesk-startup.log by default, or
 *     LOG_FILE), because some hosts (SiteGround) don't show a running app's output anywhere;
 *   - loads settings from apps/api/.env, and from the host's .env-local if the host didn't pass
 *     them to the app;
 *   - records why it stopped if it crashes.
 * Only setting names are logged, never their values.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { folderPath } from "./lib/paths";

const logFile = folderPath(process.env.LOG_FILE || "~/crewdesk-startup.log");
let logging = true;
try {
  // Keep the file small: start over once it passes 1 MB.
  if (existsSync(logFile) && statSync(logFile).size > 1_000_000) writeFileSync(logFile, "");
  appendFileSync(logFile, `\n===== ${new Date().toISOString()} =====\n`);
} catch {
  logging = false;
}
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    if (logging) try { appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${format(...args)}\n`); } catch { logging = false; }
  };
}
if (logging) console.log(`Writing this log to ${logFile}`);

/** KEY=value lines (optionally "export KEY=value", optionally quoted). Doesn't replace settings already set. */
export function loadSettingsFile(path: string): string[] {
  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    process.env[m[1]] = value;
    loaded.push(m[1]);
  }
  return loaded;
}

function loadSettings() {
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [resolve(apiDir, ".env")];
  // SiteGround keeps the settings in .nodeapp/.env-local, a few folders above the code.
  if (!process.env.DATABASE_URL) {
    for (const start of [process.cwd(), apiDir]) {
      let dir = start;
      for (let i = 0; i < 5; i++) { candidates.push(resolve(dir, ".env-local")); dir = dirname(dir); }
    }
  }
  for (const file of new Set(candidates)) {
    if (!existsSync(file)) continue;
    try {
      const names = loadSettingsFile(file);
      if (names.length) console.log(`Loaded ${names.join(", ")} from ${file}`);
    } catch (e) {
      console.warn(`Couldn't read ${file}: ${(e as Error).message}`);
    }
  }
}

if (!process.env.NODE_ENV) (process.env as Record<string, string>).NODE_ENV = "production";
console.log(`Node.js ${process.version}, folder ${process.cwd()}`);
loadSettings();
const needed = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_KEY"];
const missing = needed.filter((k) => !process.env[k]);
console.log(`PORT is ${process.env.PORT ? `"${process.env.PORT}"` : "not set (using 3000)"}. Settings found: ${needed.filter((k) => process.env[k]).join(", ") || "none"}.`);
if (missing.length) console.error(`✖ Missing settings: ${missing.join(", ")}. Add them under the project's environment variables, then redeploy.`);

const stop = (what: string) => (err: unknown) => {
  console.error(`\n✖ Crewdesk stopped (${what}):`, err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
};
process.on("uncaughtException", stop("unexpected error"));
process.on("unhandledRejection", stop("unexpected error"));

try {
  await import("./main");
} catch (err) {
  stop("while starting")(err);
}
