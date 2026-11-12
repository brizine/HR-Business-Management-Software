/**
 * Production entry: one process serves the website and the API (under /api)
 * on a single port, so a host like SiteGround needs just one Node.js app,
 * one domain and no cross-origin setup. Run `pnpm build` at the repo root
 * first, then `pnpm start`.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import next from "next";
import { buildApp } from "./app";
import { db, pool } from "./db";
import { startScheduler } from "./lib/jobs";
import { flushNotifications } from "./lib/notify";
import { folderPath } from "./lib/paths";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(apiDir, "../web");

console.log("Starting Crewdesk: connecting to the database…");
// IDs use gen_random_uuid(), built into PostgreSQL 13+. Older servers need pgcrypto for it.
const { rows } = await pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v").catch((err: NodeJS.ErrnoException) => {
  // Say plainly what to check; the full error follows.
  const where = (() => { try { const u = new URL(process.env.DATABASE_URL ?? ""); return `${u.hostname}:${u.port || 5432}, database "${u.pathname.slice(1)}", user "${decodeURIComponent(u.username)}"`; } catch { return "the DATABASE_URL setting (it doesn't look like postgres://USER:PASSWORD@HOST:5432/DATABASE)"; } })();
  console.error(`\n✖ Couldn't connect to the database at ${where}.`);
  console.error(err.code === "28P01" ? "  The password was refused: check the password in DATABASE_URL (write @ : / as %40 %3A %2F)." : err.code === "3D000" ? "  That database doesn't exist: check its name in DATABASE_URL." : err.code === "ECONNREFUSED" ? "  Nothing answered there: check the host and port in DATABASE_URL (SiteGround shows them under PostgreSQL)." : "  Check DATABASE_URL.");
  throw err;
});
if (Number(rows[0].v) < 130000) {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto").catch((err) => {
    throw new Error(`PostgreSQL ${rows[0].v} needs the pgcrypto extension; ask your host to enable it (${err.message})`);
  });
}

console.log(`Connected to PostgreSQL ${Math.floor(Number(rows[0].v) / 10000)}. Updating database tables…`);
// Bring the database schema up to date on every start, so deploys need no shell access.
await migrate(db, { migrationsFolder: resolve(apiDir, "drizzle") });

console.log("Database is up to date. Starting the website…");
const app = await buildApp({ prefix: "/api" });

if (!existsSync(resolve(webDir, ".next/BUILD_ID"))) {
  throw new Error(`No web build found in ${webDir}/.next. Run "pnpm build" at the repo root before "pnpm start".`);
}
const web = next({ dev: false, dir: webDir });
await web.prepare();
const handle = web.getRequestHandler();

await app.register(async (site: FastifyInstance) => {
  // Hand Next.js the raw, unread request body.
  site.removeAllContentTypeParsers();
  site.addContentTypeParser("*", (_req, _payload, done) => done(null));
  // Not OPTIONS: @fastify/cors already answers preflight requests for every path.
  site.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], url: "/*", handler: async (req, reply) => {
    if (req.url === "/api" || req.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "Not found" });
    }
    reply.hijack();
    await handle(req.raw, reply.raw);
  } });
});

// PORT is normally a number; some hosts hand the app a socket file path instead, so accept both.
const rawPort = (process.env.PORT ?? "3000").trim();
const socketPath = /^\d+$/.test(rawPort) ? null : rawPort;
const port = socketPath ? 0 : Number(rawPort);
console.log(socketPath ? `Listening on socket ${socketPath}` : `Listening on port ${port}`);
try {
  await app.listen(socketPath ? { path: socketPath } : { port, host: process.env.HOST ?? "0.0.0.0" });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  // Usually Crewdesk is already running in another terminal (Codespaces starts one by itself).
  console.error(`\n✖ Port ${port} is already in use, so Crewdesk is probably already running in another terminal.`);
  console.error(`  Use that one, or stop every copy with:  pkill -f apps/api/dist/main.js   and start again.\n`);
  process.exit(1);
}
// Where files are kept, so the deployment log shows the full path of the uploads folder.
console.log(process.env.S3_BUCKET ? `Uploaded documents are stored in the "${process.env.S3_BUCKET}" bucket.` : `Uploaded documents are stored in ${folderPath(process.env.UPLOAD_DIR ?? "./uploads")}`);
console.log(`\n✔ Crewdesk is running on ${socketPath ? `socket ${socketPath}` : `port ${port}`}.${process.env.CODESPACES ? " Open the Ports tab and click the globe next to port " + port + "." : ""}\n`);

const timer = process.env.DISABLE_SCHEDULER === "true" ? null : startScheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await flushNotifications();
    await pool.end();
    process.exit(0);
  });
}
