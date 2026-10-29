import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { registerErrorHandler } from "./lib/errors";
import { SESSION_COOKIE } from "./lib/auth";
import authRoutes from "./routes/auth";
import employeeRoutes from "./routes/employees";
import documentRoutes, { documentViewRoutes } from "./routes/documents";
import timeRoutes from "./routes/time";
import ptoRoutes from "./routes/pto";
import hiringRoutes from "./routes/hiring";
import onboardingRoutes from "./routes/onboarding";
import assetRoutes from "./routes/assets";
import workOrderRoutes from "./routes/workOrders";
import inspectionRoutes from "./routes/inspections";
import payrollRoutes from "./routes/payroll";
import dashboardRoutes from "./routes/dashboard";
import notificationRoutes from "./routes/notifications";
import shiftRoutes from "./routes/shifts";
import unsubscribeRoutes from "./routes/unsubscribe";
import availabilityRoutes from "./routes/availability";
import jobRoutes from "./routes/jobs";
import taxFormRoutes from "./routes/taxForms";

export interface AppOptions {
  logger?: boolean;
  /**
   * Mount point for the API. Development and tests serve it at the root of
   * its own port; production serves it under "/api" next to the website.
   */
  prefix?: string;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Behind the host's proxy, so req.ip (recorded with e-signatures) is the real client.
    trustProxy: process.env.NODE_ENV === "production",
  });

  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("JWT_SECRET must be set in production");

  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(","),
    // @fastify/cors only allows GET/HEAD/POST by default; the web app also edits and deletes.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  });
  await app.register(cookie);
  // The website's session lives in an HttpOnly cookie; the phone app sends a bearer token.
  await app.register(jwt, { secret: secret ?? "dev-only-secret", sign: { expiresIn: "7d" }, cookie: { cookieName: SESSION_COOKIE, signed: false } });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  // Opt-in per route (sign-in endpoints set config.rateLimit).
  await app.register(rateLimit, { global: false });
  registerErrorHandler(app);
  await app.register(apiRoutes, { prefix: opts.prefix ?? "" });
  return app;
}

async function apiRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(employeeRoutes, { prefix: "/employees" });
  await app.register(documentRoutes, { prefix: "/documents" });
  await app.register(documentViewRoutes, { prefix: "/documents/view" });
  await app.register(timeRoutes, { prefix: "/time" });
  await app.register(ptoRoutes, { prefix: "/pto" });
  await app.register(hiringRoutes);
  await app.register(onboardingRoutes, { prefix: "/onboarding" });
  await app.register(assetRoutes, { prefix: "/assets" });
  await app.register(workOrderRoutes, { prefix: "/work-orders" });
  await app.register(inspectionRoutes, { prefix: "/inspections" });
  await app.register(payrollRoutes, { prefix: "/payroll" });
  await app.register(dashboardRoutes, { prefix: "/dashboard" });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(shiftRoutes, { prefix: "/shifts" });
  await app.register(unsubscribeRoutes, { prefix: "/public/unsubscribe" });
  await app.register(availabilityRoutes, { prefix: "/availability" });
  await app.register(jobRoutes, { prefix: "/jobs" });
  await app.register(taxFormRoutes, { prefix: "/tax-forms" });
}
