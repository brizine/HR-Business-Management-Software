import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../lib/errors";
import { runScheduledChecks } from "../lib/jobs";

/**
 * Lets a host's cron (e.g. SiteGround Site Tools > Devs > Cron Jobs) trigger
 * the scheduled checks with `curl -X POST -H "X-Jobs-Secret: …" https://…/api/jobs/run`.
 * A backstop for hosts that restart or pause the app process; the checks are
 * idempotent, so running them from both the timer and cron is harmless.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.post("/run", async (req) => {
    const secret = process.env.JOBS_SECRET;
    const given = req.headers["x-jobs-secret"];
    const ok =
      !!secret && typeof given === "string" && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) throw new HttpError(404, "Not found");
    return runScheduledChecks();
  });
};

export default routes;
