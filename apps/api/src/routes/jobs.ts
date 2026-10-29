import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../lib/errors";
import { runBackup } from "../lib/backup";
import { runScheduledChecks } from "../lib/jobs";

/**
 * Lets a host's cron (e.g. SiteGround Site Tools > Devs > Cron Jobs) trigger
 * the scheduled checks with `curl -X POST -H "X-Jobs-Secret: …" https://…/api/jobs/run`.
 * A backstop for hosts that restart or pause the app process; the checks are
 * idempotent, so running them from both the timer and cron is harmless.
 */
function checkSecret(given: unknown) {
  const secret = process.env.JOBS_SECRET;
  const ok =
    !!secret && typeof given === "string" && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new HttpError(404, "Not found");
}

const routes: FastifyPluginAsync = async (app) => {
  app.post("/run", async (req) => {
    checkSecret(req.headers["x-jobs-secret"]);
    return runScheduledChecks();
  });

  /** Nightly encrypted database backup, for the host's cron (see docs/deploy-siteground.md). */
  app.post("/backup", async (req) => {
    checkSecret(req.headers["x-jobs-secret"]);
    return runBackup();
  });
};

export default routes;
