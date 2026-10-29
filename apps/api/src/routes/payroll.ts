import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";
import { companyPayrollInfoSchema, payrollExportSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { companies, payrollRuns } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { buildPayrollLines, getProvider, payrollCsv } from "../lib/payroll";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("admin"));

  app.get("/settings", async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return {
      payrollProvider: c.payrollProvider,
      payrollProviderCompanyId: c.payrollProviderCompanyId,
      weeklyOvertimeThreshold: c.weeklyOvertimeThreshold,
      availableProviders: ["csv", "check"],
      legalName: c.legalName,
      ein: c.ein,
      address: c.address,
      taxFormsInCrewdesk: c.taxFormsInCrewdesk,
    };
  });

  app.put("/settings", { preHandler: requireRole("owner") }, async (req) => {
    const body = parse(
      z
        .object({
          /** "csv" = no provider: export and run payroll manually. */
          payrollProvider: z.enum(["csv", "check"]).optional(),
          payrollProviderCompanyId: z.string().nullable().optional(),
          weeklyOvertimeThreshold: z.number().positive().optional(),
          /** Collect W-4, I-9 and direct deposit in Biz Management Software. */
          taxFormsInCrewdesk: z.boolean().optional(),
        })
        .merge(companyPayrollInfoSchema),
      req.body,
    );
    const [c] = await db.update(companies).set(body).where(eq(companies.id, req.user.companyId)).returning();
    return {
      payrollProvider: c.payrollProvider,
      payrollProviderCompanyId: c.payrollProviderCompanyId,
      weeklyOvertimeThreshold: c.weeklyOvertimeThreshold,
      legalName: c.legalName,
      ein: c.ein,
      address: c.address,
      taxFormsInCrewdesk: c.taxFormsInCrewdesk,
    };
  });

  /** Hours and estimated gross per employee for the period. */
  app.get("/preview", async (req) => {
    const period = parse(payrollExportSchema, req.query);
    return buildPayrollLines(db, req.user.companyId, period);
  });

  /** Timesheet CSV that can be imported into any payroll system. */
  app.get("/export.csv", async (req, reply) => {
    const period = parse(payrollExportSchema, req.query);
    const lines = await buildPayrollLines(db, req.user.companyId, period);
    await db.insert(payrollRuns).values({
      companyId: req.user.companyId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      provider: "csv",
      status: "exported",
      totals: totals(lines),
      createdById: req.user.sub,
    });
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="timesheets-${period.periodStart}-to-${period.periodEnd}.csv"`);
    return payrollCsv(lines);
  });

  /** Sends hours to the company's configured payroll provider. */
  app.post("/submit", async (req) => {
    const period = parse(payrollExportSchema, req.body);
    const [company] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    const provider = getProvider(company.payrollProvider);
    if (!provider) throw new HttpError(400, "No payroll provider is connected. Use CSV export or connect one in settings.");
    if (!company.payrollProviderCompanyId) throw new HttpError(400, "Company is not linked to the payroll provider yet");
    const lines = await buildPayrollLines(db, req.user.companyId, period);
    let result;
    try {
      result = await provider.submit(company.payrollProviderCompanyId, period, lines);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    const [run] = await db
      .insert(payrollRuns)
      .values({
        companyId: company.id,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        provider: provider.name,
        status: result.status,
        providerReference: result.providerReference,
        totals: totals(lines),
        createdById: req.user.sub,
      })
      .returning();
    return run;
  });

  app.get("/runs", async (req) =>
    db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.companyId, req.user.companyId))
      .orderBy(desc(payrollRuns.createdAt))
      .limit(50),
  );
};

function totals(lines: Awaited<ReturnType<typeof buildPayrollLines>>) {
  return {
    employees: lines.filter((l) => l.totalHours > 0 || l.ptoHours > 0).length,
    regularHours: lines.reduce((s, l) => s + l.regularHours, 0),
    overtimeHours: lines.reduce((s, l) => s + l.overtimeHours, 0),
    ptoHours: lines.reduce((s, l) => s + l.ptoHours, 0),
    estimatedGrossCents: lines.reduce((s, l) => s + (l.estimatedGrossCents ?? 0), 0),
  };
}

export default routes;
