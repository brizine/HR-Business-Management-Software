import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { registerErrorHandler } from "./lib/errors";
import { liveStamp } from "./lib/source-stamp";
import { SESSION_COOKIE } from "./lib/auth";
import authRoutes from "./routes/auth";
import employeeRoutes from "./routes/employees";
import documentRoutes, { documentViewRoutes } from "./routes/documents";
import timeRoutes from "./routes/time";
import ptoRoutes from "./routes/pto";
import holidayRoutes from "./routes/holidays";
import reviewRoutes from "./routes/reviews";
import attendanceRoutes from "./routes/attendance";
import trainingRoutes from "./routes/training";
import accountingRoutes from "./routes/accounting";
import hiringRoutes from "./routes/hiring";
import onboardingRoutes from "./routes/onboarding";
import assetRoutes from "./routes/assets";
import workOrderRoutes from "./routes/workOrders";
import inspectionRoutes from "./routes/inspections";
import payrollRoutes from "./routes/payroll";
import payPeriodRoutes from "./routes/payPeriods";
import permissionRoutes from "./routes/permissions";
import companyRoutes from "./routes/company";
import dashboardRoutes from "./routes/dashboard";
import notificationRoutes from "./routes/notifications";
import shiftRoutes from "./routes/shifts";
import unsubscribeRoutes from "./routes/unsubscribe";
import availabilityRoutes from "./routes/availability";
import jobRoutes from "./routes/jobs";
import taxFormRoutes from "./routes/taxForms";
import wikiRoutes from "./routes/wiki";
import jobSiteRoutes from "./routes/jobSites";
import helpRoutes from "./routes/help";
import extraPayRoutes from "./routes/extraPay";
import fuelRoutes from "./routes/fuel";
import calendarRoutes from "./routes/calendar";
import publicCompanyRoutes from "./routes/publicCompany";
import sprayMixRoutes from "./routes/sprayMix";
import measurementRoutes from "./routes/measurements";
import customerRoutes from "./routes/customers";
import customerMessageRoutes from "./routes/customerMessages";
import paymentMethodRoutes from "./routes/paymentMethods";
import customerPageRoutes from "./routes/customerPage";
import estimateRoutes, { publicEstimateRoutes } from "./routes/estimates";
import textingRoutes, { textingHookRoutes } from "./routes/texting";
import automationRoutes from "./routes/automations";
import myDayRoutes from "./routes/myDay";
import waitlistRoutes from "./routes/waitlist";
import weatherRoutes from "./routes/weather";
import templateRoutes, { emailImageRoutes, trackRoutes } from "./routes/templates";
import docRoutes from "./routes/docs";
import visitFormRoutes from "./routes/visitForms";
import propertyRoutes from "./routes/properties";
import crmSettingsRoutes from "./routes/crmSettings";
import searchRoutes from "./routes/search";
import todoRoutes from "./routes/todos";
import offSeasonRoutes from "./routes/offSeasons";
import customFieldRoutes from "./routes/customFields";
import eventRoutes from "./routes/events";
import visitRoutes from "./routes/visits";
import crewRoutes from "./routes/crews";
import packageRoutes from "./routes/packages";
import { flushBillingSync } from "./lib/billingSync";
import serviceTypeRoutes from "./routes/serviceTypes";
import productRoutes from "./routes/products";
import chemicalTrackingRoutes from "./routes/chemicalTracking";
import chemicalRecordRoutes from "./routes/chemicalRecords";
import invoiceRoutes from "./routes/invoices";
import creditRoutes from "./routes/credits";
import prepaymentRoutes, { prepayLinkRoutes } from "./routes/prepayments";
import { stripeSettingsRoutes, stripeWebhookRoutes } from "./routes/stripe";
import { payLinkRoutes, portalRoutes } from "./routes/portal";

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
  // Every answer is personal and changes as people edit, so no proxy or browser may keep a copy.
  // Without this, a host's cache (e.g. SiteGround's dynamic cache) can keep serving an old schedule
  // after a shift is deleted. Routes that set their own caching (photos, logo) keep it.
  // Let background Bigcapital syncs finish before shutting down.
  app.addHook("onClose", async () => { await flushBillingSync(); });
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  await app.register(apiRoutes, { prefix: opts.prefix ?? "" });
  return app;
}

async function apiRoutes(app: FastifyInstance) {
  // `build` says which code this server is running (see lib/source-stamp.ts).
  app.get("/health", async () => ({ ok: true, build: liveStamp() }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(employeeRoutes, { prefix: "/employees" });
  await app.register(documentRoutes, { prefix: "/documents" });
  await app.register(documentViewRoutes, { prefix: "/documents/view" });
  await app.register(timeRoutes, { prefix: "/time" });
  await app.register(ptoRoutes, { prefix: "/pto" });
  await app.register(holidayRoutes, { prefix: "/holidays" });
  await app.register(reviewRoutes, { prefix: "/reviews" });
  await app.register(attendanceRoutes, { prefix: "/attendance" });
  await app.register(trainingRoutes, { prefix: "/training" });
  await app.register(accountingRoutes, { prefix: "/accounting" });
  await app.register(hiringRoutes);
  await app.register(onboardingRoutes, { prefix: "/onboarding" });
  await app.register(assetRoutes, { prefix: "/assets" });
  await app.register(workOrderRoutes, { prefix: "/work-orders" });
  await app.register(inspectionRoutes, { prefix: "/inspections" });
  await app.register(payrollRoutes, { prefix: "/payroll" });
  await app.register(payPeriodRoutes, { prefix: "/pay-periods" });
  await app.register(permissionRoutes, { prefix: "/permissions" });
  await app.register(companyRoutes, { prefix: "/company" });
  await app.register(dashboardRoutes, { prefix: "/dashboard" });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(shiftRoutes, { prefix: "/shifts" });
  await app.register(unsubscribeRoutes, { prefix: "/public/unsubscribe" });
  await app.register(availabilityRoutes, { prefix: "/availability" });
  await app.register(jobRoutes, { prefix: "/jobs" });
  await app.register(taxFormRoutes, { prefix: "/tax-forms" });
  await app.register(wikiRoutes, { prefix: "/wiki" });
  await app.register(jobSiteRoutes, { prefix: "/job-sites" });
  await app.register(helpRoutes, { prefix: "/help" });
  await app.register(extraPayRoutes, { prefix: "/extra-pay" });
  await app.register(fuelRoutes, { prefix: "/fuel" });
  // Public (the secret link is the key): calendar subscriptions.
  await app.register(calendarRoutes, { prefix: "/calendar" });
  await app.register(publicCompanyRoutes, { prefix: "/public/company" });
  await app.register(sprayMixRoutes, { prefix: "/spray-mixes" });
  await app.register(measurementRoutes, { prefix: "/measurements" });
  await app.register(customerRoutes, { prefix: "/customers" });
  await app.register(customerMessageRoutes, { prefix: "/customer-messages" });
  await app.register(paymentMethodRoutes, { prefix: "/customers" });
  await app.register(customerPageRoutes, { prefix: "/customers" });
  await app.register(estimateRoutes, { prefix: "/estimates" });
  await app.register(textingHookRoutes, { prefix: "/texting/hooks" });
  await app.register(textingRoutes, { prefix: "/texting" });
  await app.register(automationRoutes, { prefix: "/automations" });
  await app.register(myDayRoutes, { prefix: "/my-day" });
  await app.register(waitlistRoutes, { prefix: "/waitlist" });
  await app.register(weatherRoutes, { prefix: "/weather" });
  await app.register(templateRoutes, { prefix: "/templates" });
  await app.register(docRoutes, { prefix: "/docs" });
  await app.register(visitFormRoutes, { prefix: "/visit-forms" });
  await app.register(trackRoutes, { prefix: "/public/t" });
  await app.register(emailImageRoutes, { prefix: "/public/email-image" });
  await app.register(publicEstimateRoutes, { prefix: "/public/estimates" });
  await app.register(propertyRoutes, { prefix: "/properties" });
  await app.register(crmSettingsRoutes, { prefix: "/crm" });
  await app.register(searchRoutes, { prefix: "/search" });
  await app.register(todoRoutes, { prefix: "/todos" });
  await app.register(offSeasonRoutes, { prefix: "/off-seasons" });
  await app.register(customFieldRoutes, { prefix: "/custom-fields" });
  await app.register(eventRoutes, { prefix: "/events" });
  await app.register(visitRoutes, { prefix: "/visits" });
  await app.register(crewRoutes, { prefix: "/crews" });
  await app.register(packageRoutes, { prefix: "/packages" });
  await app.register(serviceTypeRoutes, { prefix: "/service-types" });
  await app.register(productRoutes, { prefix: "/products" });
  await app.register(chemicalRecordRoutes, { prefix: "/chemical-records" });
  await app.register(chemicalTrackingRoutes, { prefix: "/chemical-tracking" });
  await app.register(invoiceRoutes, { prefix: "/invoices" });
  await app.register(creditRoutes, { prefix: "/credits" });
  await app.register(prepaymentRoutes, { prefix: "/prepayments" });
  await app.register(stripeSettingsRoutes, { prefix: "/stripe" });
  // Public, but checked against the company's Stripe signing secret.
  await app.register(stripeWebhookRoutes, { prefix: "/stripe" });
  // Public: the customer portal (its own sign-in) and invoice pay links.
  await app.register(portalRoutes, { prefix: "/portal" });
  await app.register(payLinkRoutes, { prefix: "/pay" });
  await app.register(prepayLinkRoutes, { prefix: "/prepay" });
}
