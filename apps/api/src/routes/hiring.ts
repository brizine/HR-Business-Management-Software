import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { applicantSchema, applicantStageSchema, hireSchema, jobSchema } from "@crewdesk/shared";
import { db } from "../db";
import { applicants, companies, employees, jobs } from "../db/schema";
import { authenticate, canManageAccount, requireRole } from "../lib/auth";
import { sendInvite } from "../lib/invites";
import { HttpError, notFound, parse } from "../lib/errors";
import { notify, staffWithRole } from "../lib/notify";
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
    notify(job.companyId, await staffWithRole(job.companyId, "manager"), {
      category: "hiring",
      title: `New applicant: ${job.title}`,
      body: `${body.firstName} ${body.lastName} applied.`,
      link: { screen: "hiring" },
    });
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

    /**
     * Hires an applicant: creates their employee record (status "onboarding"),
     * starts the chosen checklist, and emails them an invite to set up their
     * login. The response includes the invite link in case email isn't set up.
     */
    priv.post<{ Params: { id: string } }>("/applicants/:id/hire", { preHandler: requireRole("admin") }, async (req) => {
      const body = parse(hireSchema, req.body ?? {});
      if (!canManageAccount(req.user.role, body.role)) throw new HttpError(403, "Only the owner can hire someone as an admin");
      const [applicant] = await db
        .select()
        .from(applicants)
        .where(and(eq(applicants.id, req.params.id), eq(applicants.companyId, req.user.companyId)));
      if (!applicant) notFound("Applicant");
      if (applicant.hiredEmployeeId) throw new HttpError(409, "This applicant was already hired");
      if (body.managerId) {
        const [mgr] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, body.managerId), eq(employees.companyId, req.user.companyId)));
        if (!mgr) notFound("Manager");
      }
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
            department: body.department ?? job?.department,
            role: body.role,
            managerId: body.managerId ?? null,
            payType: body.payType,
            payRateCents: body.payRateCents,
            employmentType: body.employmentType,
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

      const tasks = body.onboardingTemplateId
        ? await applyOnboardingTemplate(req.user.companyId, employee.id, body.onboardingTemplateId, req.user.sub)
        : [];
      const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
      const invite = body.sendInvite ? await sendInvite(employee, `${me.firstName} ${me.lastName}`) : null;
      return { ...publicEmployee(employee), tasks: tasks.length, invite };
    });
  });
};

export default routes;
