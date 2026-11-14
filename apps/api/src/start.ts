/**
 * What `pnpm start` / `npm start` runs in production. Before starting Crewdesk (main.ts) it:
 *   - copies everything Crewdesk prints into ~/crewdesk-startup.log (or LOG_FILE) and a copy in
 *     the app's own folder, because some hosts (SiteGround) don't show a running app's output anywhere;
 *   - loads settings from apps/api/.env, and from the host's .env-local if the host didn't pass
 *     them to the app;
 *   - records why it stopped if it crashes.
 * Only setting names are logged, never their values.
 */
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { folderPath } from "./lib/paths";
import { loadSettings } from "./lib/settings-file";
import { removeOlderBuilds } from "./lib/prune-builds";

// The home folder, plus a copy next to the code (SiteGround: .nodeapp/<build>/app_source), in case
// the home folder isn't writable or isn't where you're looking.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const logFiles = [...new Set([folderPath(process.env.LOG_FILE || "~/crewdesk-startup.log"), resolve(appRoot, "crewdesk-startup.log")])].filter((file) => {
  try {
    // Keep each file small: start over once it passes 1 MB.
    if (existsSync(file) && statSync(file).size > 1_000_000) writeFileSync(file, "");
    appendFileSync(file, `\n===== ${new Date().toISOString()} =====\n`);
    return true;
  } catch {
    return false;
  }
});
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const line = `${new Date().toISOString().slice(11, 19)} ${format(...args)}\n`;
    for (const file of logFiles) try { appendFileSync(file, line); } catch { /* keep going */ }
  };
}
if (logFiles.length) console.log(`Writing this log to ${logFiles.join(" and ")}`);

if (!process.env.NODE_ENV) (process.env as Record<string, string>).NODE_ENV = "production";
console.log(`Node.js ${process.version}, folder ${process.cwd()}`);
loadSettings(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const needed = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_KEY"];
const missing = needed.filter((k) => !process.env[k]);
console.log(`PORT is ${process.env.PORT ? `"${process.env.PORT}"` : "not set (using 3000)"}. Settings found: ${needed.filter((k) => process.env[k]).join(", ") || "none"}.`);
if (missing.length) console.error(`✖ Missing settings: ${missing.join(", ")}. Add them under the project's environment variables, then redeploy.`);

// The previous deploy's copy isn't needed once this one is running (SiteGround keeps every copy).
removeOlderBuilds(appRoot);

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
