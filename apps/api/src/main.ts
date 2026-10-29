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

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(apiDir, "../web");

// IDs use gen_random_uuid(), built into PostgreSQL 13+. Older servers need pgcrypto for it.
const { rows } = await pool.query<{ v: string }>("SHOW server_version_num");
if (Number(rows[0].v) < 130000) {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto").catch((err) => {
    throw new Error(`PostgreSQL ${rows[0].v} needs the pgcrypto extension; ask your host to enable it (${err.message})`);
  });
}

// Bring the database schema up to date on every start, so deploys need no shell access.
await migrate(db, { migrationsFolder: resolve(apiDir, "drizzle") });

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

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" });

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
