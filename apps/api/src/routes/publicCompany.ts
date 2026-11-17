import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { companies } from "../db/schema";
import { imageType } from "../lib/images";
import { storage } from "../lib/storage";

/**
 * Public company branding (no sign-in): the logo, for the phone app's sign-in screen. The app
 * remembers the company of whoever last signed in on the phone and shows its logo there.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/:id/logo", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "Not found" });
    const [c] = await db.select({ key: companies.logoKey }).from(companies).where(eq(companies.id, req.params.id));
    if (!c?.key) return reply.code(404).send({ error: "No logo" });
    const buf = await storage.get(c.key);
    reply.header("Content-Type", imageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
  });
};

export default routes;
