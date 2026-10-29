import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { applicantSchema, applicantStageSchema, jobSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { applicants, companies, employees, jobs } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { notFound, parse } from "../lib/errors";
import { applyOnboardingTemplate } from "./onboarding";
import { publicEmployee } from "./employees";

const routes: FastifyPluginAsync = async (app) => {
  // ---- Public careers page (no auth) ----
  app.get<{ Params: { companyId: string } }>("/public/:companyId/jobs", async (req) => {
    const [company] = await db.select().from(companies).where(eq(companies.id, req.params.companyId));
    if (!company) notFound("Company");
    const open = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        department: jobs.department,
        location: jobs.location,
        description: jobs.description,
        payRange: jobs.payRange,
      })
      .from(jobs)
      .where(and(eq(jobs.companyId, company.id), eq(jobs.status, "open")));
    return { company: { id: company.id, name: company.name }, jobs: open };
  });

  app.post<{ Params: { jobId: string } }>("/public/jobs/:jobId/apply", async (req) => {
    const body = parse(applicantSchema, req.body);
    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, req.params.jobId), eq(jobs.status, "open")));
    if (!job) notFound("Job");
    await db.insert(applicants).values({ ...body, jobId: job.id, companyId: job.companyId });
    return { ok: true };
  });

  // ---- Authenticated hiring management ----
  app.register(async (priv) => {
    priv.addHook("preHandler", authenticate);
    priv.addHook("preHandler", requireRole("manager"));

    priv.get("/jobs", async (req) =>
      db.select().from(jobs).where(eq(jobs.companyId, req.user.companyId)).orderBy(desc(jobs.createdAt)),
    );

    priv.post("/jobs", async (req) => {
      const body = parse(jobSchema, req.body);
      const [row] = await db
        .insert(jobs)
        .values({ ...body, companyId: req.user.companyId })
        .returning();
      return row;
    });

    priv.patch<{ Params: { id: string } }>("/jobs/:id", async (req) => {
      const body = parse(jobSchema.partial(), req.body);
      const [row] = await db
        .update(jobs)
        .set(body)
        .where(and(eq(jobs.id, req.params.id), eq(jobs.companyId, req.user.companyId)))
        .returning();
      if (!row) notFound("Job");
      return row;
    });

    priv.get<{ Querystring: { jobId?: string } }>("/applicants", async (req) => {
      const filters = [eq(applicants.companyId, req.user.companyId)];
      if (req.query.jobId) filters.push(eq(applicants.jobId, req.query.jobId));
      return db
        .select()
        .from(applicants)
        .where(and(...filters))
        .orderBy(desc(applicants.createdAt));
    });

    priv.post<{ Params: { jobId: string } }>("/jobs/:jobId/applicants", async (req) => {
      const body = parse(applicantSchema, req.body);
      const [job] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, req.params.jobId), eq(jobs.companyId, req.user.companyId)));
      if (!job) notFound("Job");
      const [row] = await db
        .insert(applicants)
        .values({ ...body, jobId: job.id, companyId: job.companyId })
        .returning();
      return row;
    });

    priv.patch<{ Params: { id: string } }>("/applicants/:id/stage", async (req) => {
      const { stage } = parse(applicantStageSchema, req.body);
      const [row] = await db
        .update(applicants)
        .set({ stage })
        .where(and(eq(applicants.id, req.params.id), eq(applicants.companyId, req.user.companyId)))
        .returning();
      if (!row) notFound("Applicant");
      return row;
    });

    /** Converts an applicant into an onboarding employee, optionally applying a checklist template. */
    priv.post<{ Params: { id: string } }>("/applicants/:id/hire", { preHandler: requireRole("admin") }, async (req) => {
      const body = parse(
        z.object({
          startDate: z.string().optional(),
          title: z.string().optional(),
          payRateCents: z.number().int().nonnegative().default(0),
          onboardingTemplateId: z.string().uuid().optional(),
        }),
        req.body ?? {},
      );
      const [applicant] = await db
        .select()
        .from(applicants)
        .where(and(eq(applicants.id, req.params.id), eq(applicants.companyId, req.user.companyId)));
      if (!applicant) notFound("Applicant");
      const [job] = await db.select().from(jobs).where(eq(jobs.id, applicant.jobId));

      const employee = await db.transaction(async (tx) => {
        const [emp] = await tx
          .insert(employees)
          .values({
            companyId: req.user.companyId,
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            email: applicant.email.toLowerCase(),
            phone: applicant.phone,
            title: body.title ?? job?.title,
            department: job?.department,
            payRateCents: body.payRateCents,
            startDate: body.startDate,
            status: "onboarding",
          })
          .returning();
        await tx
          .update(applicants)
          .set({ stage: "hired", hiredEmployeeId: emp.id })
          .where(eq(applicants.id, applicant.id));
        return emp;
      });

      if (body.onboardingTemplateId) {
        await applyOnboardingTemplate(req.user.companyId, employee.id, body.onboardingTemplateId, body.startDate);
      }
      return publicEmployee(employee);
    });
  });
};

export default routes;
