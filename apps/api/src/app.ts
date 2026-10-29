import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { registerErrorHandler } from "./lib/errors";
import authRoutes from "./routes/auth";
import employeeRoutes from "./routes/employees";
import documentRoutes from "./routes/documents";
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

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true });

  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("JWT_SECRET must be set in production");

  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(","),
    // @fastify/cors only allows GET/HEAD/POST by default; the web app also edits and deletes.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  });
  await app.register(jwt, { secret: secret ?? "dev-only-secret", sign: { expiresIn: "7d" } });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  registerErrorHandler(app);

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(employeeRoutes, { prefix: "/employees" });
  await app.register(documentRoutes, { prefix: "/documents" });
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

  return app;
}
