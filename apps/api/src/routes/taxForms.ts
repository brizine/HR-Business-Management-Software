import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  TAX_FORM_LABELS,
  W4_AMOUNTS,
  directDepositSchema,
  hasRole,
  i9Section1Schema,
  i9Section2Schema,
  maskAccount,
  maskSsn,
  w4Schema,
  type DirectDeposit,
  type I9Section1,
  type I9Section2,
  type Role,
  type TaxFormType,
  type W4,
} from "@crewdesk/shared";
import type { ZodType } from "zod";
import { db } from "../db";
import { companies, employees, onboardingTasks, sensitiveAccessLog, taxForms } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { decrypt, encrypt } from "../lib/crypto";
import { HttpError, notFound, parse } from "../lib/errors";
import { except, notify, staffWithRole } from "../lib/notify";
import { directDepositPdf, i9Pdf, w4Pdf, type Employer } from "../lib/taxFormPdf";
import { completeTask } from "./onboarding";

const PURPOSE = "tax-forms-v1";
type Form = typeof taxForms.$inferSelect;

const seal = (data: unknown) => encrypt(JSON.stringify(data), PURPOSE);
const open = <T>(stored: string) => JSON.parse(decrypt(stored, PURPOSE)) as T;
const isAdmin = (req: FastifyRequest) => hasRole(req.user.role as Role, "admin");

const CITIZENSHIP_LABELS: Record<I9Section1["citizenship"], string> = {
  citizen: "U.S. citizen",
  noncitizen_national: "Noncitizen national",
  permanent_resident: "Lawful permanent resident",
  authorized_alien: "Noncitizen authorized to work",
};

/** Safe-to-list summary: never the full SSN or account number. */
function summarize(type: TaxFormType, data: W4 | I9Section1 | DirectDeposit) {
  if (type === "w4") {
    const d = data as W4;
    return `SSN ${maskSsn(d.ssn)} · ${d.exempt ? "exempt" : d.filingStatus.replace(/_/g, " ")}`;
  }
  if (type === "direct_deposit") {
    const d = data as DirectDeposit;
    return `${d.bankName} ${d.accountType} ${maskAccount(d.accountNumber)}`;
  }
  return CITIZENSHIP_LABELS[(data as I9Section1).citizenship];
}

function listItem(f: Form) {
  return {
    id: f.id,
    employeeId: f.employeeId,
    type: f.type,
    label: TAX_FORM_LABELS[f.type as TaxFormType],
    status: f.status,
    summary: f.summary,
    signedName: f.signedName,
    signedAt: f.signedAt,
    employerSignedName: f.employerSignedName,
    employerSignedAt: f.employerSignedAt,
    processedAt: f.processedAt,
    supersededAt: f.supersededAt,
    createdAt: f.createdAt,
  };
}

async function employerFor(companyId: string): Promise<Employer> {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  return { name: c.name, legalName: c.legalName, ein: c.ein, address: c.address };
}

async function logAccess(req: FastifyRequest, form: Form, action: string) {
  await db.insert(sensitiveAccessLog).values({
    companyId: form.companyId,
    viewerId: req.user.sub,
    employeeId: form.employeeId,
    taxFormId: form.id,
    action,
    ip: req.ip,
  });
}

const SCHEMAS: Record<TaxFormType, ZodType> = { w4: w4Schema, i9: i9Section1Schema, direct_deposit: directDepositSchema };

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Only the employee themselves and admins (who run payroll) can open a form. */
  async function loadForm(req: FastifyRequest, id: string) {
    const [form] = await db
      .select()
      .from(taxForms)
      .where(and(eq(taxForms.id, id), eq(taxForms.companyId, req.user.companyId)));
    if (!form || (form.employeeId !== req.user.sub && !isAdmin(req))) notFound("Form");
    return form;
  }

  app.get("/settings", async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return { enabled: c.taxFormsInCrewdesk, w4Amounts: W4_AMOUNTS };
  });

  /** The signed-in person's current forms (newest of each type) and older versions. */
  app.get("/mine", async (req) => {
    const rows = await db
      .select()
      .from(taxForms)
      .where(eq(taxForms.employeeId, req.user.sub))
      .orderBy(desc(taxForms.createdAt));
    return rows.map(listItem);
  });

  /**
   * Your last answers for a form type (to start an update from), minus the
   * Social Security and account numbers, which are always re-entered.
   */
  app.get<{ Params: { type: string } }>("/prefill/:type", async (req) => {
    const [form] = await db
      .select()
      .from(taxForms)
      .where(and(eq(taxForms.employeeId, req.user.sub), eq(taxForms.type, req.params.type), isNull(taxForms.supersededAt)));
    if (!form) return null;
    const { ssn, accountNumber, accountNumberConfirm, signedName, ...rest } = open<Record<string, unknown>>(form.data);
    return rest;
  });

  for (const type of ["w4", "i9", "direct_deposit"] as const) {
    app.post(`/${type.replace("_", "-")}`, async (req) => {
      const [company] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
      if (!company.taxFormsInCrewdesk) throw new HttpError(400, "Your company's payroll provider collects these forms");
      const data = parse(SCHEMAS[type], req.body) as W4 | I9Section1 | DirectDeposit;
      const { accountNumberConfirm, ...toStore } = data as DirectDeposit;
      void accountNumberConfirm;

      const [current] = await db
        .select()
        .from(taxForms)
        .where(and(eq(taxForms.employeeId, req.user.sub), eq(taxForms.type, type), isNull(taxForms.supersededAt)));
      if (type === "i9" && current?.status === "completed") {
        throw new HttpError(409, "Your I-9 has already been verified. If something changed (like a new name), tell HR.");
      }

      const form = await db.transaction(async (tx) => {
        if (current) await tx.update(taxForms).set({ supersededAt: new Date() }).where(eq(taxForms.id, current.id));
        const [row] = await tx
          .insert(taxForms)
          .values({
            companyId: req.user.companyId,
            employeeId: req.user.sub,
            type,
            data: seal(type === "direct_deposit" ? toStore : data),
            summary: summarize(type, data),
            signedName: data.signedName,
            signedAt: new Date(),
            signedIp: req.ip,
            signedUserAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
          })
          .returning();
        return row;
      });

      // Finish any onboarding task waiting on this form.
      const tasks = await db
        .select()
        .from(onboardingTasks)
        .where(and(eq(onboardingTasks.employeeId, req.user.sub), eq(onboardingTasks.formType, type), isNull(onboardingTasks.completedAt)));
      for (const t of tasks) await completeTask(t, req.user.sub);

      const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
      const who = `${me.firstName} ${me.lastName}`;
      notify(req.user.companyId, except(await staffWithRole(req.user.companyId, "admin"), req.user.sub), {
        category: "payroll",
        title:
          type === "i9"
            ? `${who} completed I-9 Section 1`
            : `${who} ${current ? "updated their" : "submitted a"} ${type === "w4" ? "W-4" : "direct deposit form"}`,
        body:
          type === "i9"
            ? "Examine their documents and complete Section 2 within 3 business days of their first day."
            : "Enter it in payroll, then mark it entered in Biz Management Software.",
        link: { screen: "tax-forms" },
      });
      return listItem(form);
    });
  }

  /** Admin: forms to act on (W-4/direct deposit not yet entered in payroll; I-9s needing Section 2). */
  app.get("/pending", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await db
      .select({ form: taxForms, employee: employees })
      .from(taxForms)
      .innerJoin(employees, eq(employees.id, taxForms.employeeId))
      .where(and(eq(taxForms.companyId, req.user.companyId), isNull(taxForms.supersededAt), ne(employees.status, "terminated")))
      .orderBy(desc(taxForms.createdAt));
    return rows
      .filter(({ form }) => (form.type === "i9" ? form.status !== "completed" : !form.processedAt))
      .map(({ form, employee }) => ({ ...listItem(form), employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}`, startDate: employee.startDate } }));
  });

  /** Admin: everything on file for one employee, including superseded versions. */
  app.get<{ Querystring: { employeeId: string } }>("/", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await db
      .select()
      .from(taxForms)
      .where(and(eq(taxForms.companyId, req.user.companyId), eq(taxForms.employeeId, req.query.employeeId)))
      .orderBy(desc(taxForms.createdAt));
    return rows.map(listItem);
  });

  /** The full form (decrypted). Every view is logged; admins see who has opened it. */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const form = await loadForm(req, req.params.id);
    await logAccess(req, form, "view");
    const log = isAdmin(req)
      ? await db
          .select({ action: sensitiveAccessLog.action, at: sensitiveAccessLog.createdAt, viewer: employees.firstName, viewerLast: employees.lastName })
          .from(sensitiveAccessLog)
          .leftJoin(employees, eq(employees.id, sensitiveAccessLog.viewerId))
          .where(eq(sensitiveAccessLog.taxFormId, form.id))
          .orderBy(desc(sensitiveAccessLog.createdAt))
          .limit(50)
      : [];
    return {
      form: listItem(form),
      data: open(form.data),
      employerData: form.employerData ? open(form.employerData) : null,
      accessLog: log.map((l) => ({ action: l.action, at: l.at, by: l.viewer ? `${l.viewer} ${l.viewerLast}` : "Unknown" })),
    };
  });

  app.get<{ Params: { id: string } }>("/:id/pdf", async (req, reply) => {
    const form = await loadForm(req, req.params.id);
    await logAccess(req, form, "download");
    const [emp] = await db.select().from(employees).where(eq(employees.id, form.employeeId));
    const employer = await employerFor(form.companyId);
    const signed = { name: form.signedName, at: form.signedAt, ip: form.signedIp };
    let bytes: Uint8Array;
    if (form.type === "w4") bytes = await w4Pdf(open<W4>(form.data), signed, employer, emp.startDate);
    else if (form.type === "i9") {
      const s2 = form.employerData
        ? { data: open<I9Section2>(form.employerData), signed: { name: form.employerSignedName!, at: form.employerSignedAt! } }
        : null;
      bytes = await i9Pdf(open<I9Section1>(form.data), signed, employer, s2);
    } else bytes = await directDepositPdf(open<DirectDeposit>(form.data), signed, employer, `${emp.firstName} ${emp.lastName}`);
    const file = `${form.type === "w4" ? "W-4" : form.type === "i9" ? "I-9" : "Direct-deposit"}-${emp.lastName}-${emp.firstName}-${form.signedAt.toISOString().slice(0, 10)}.pdf`;
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${file.replace(/[^\w.-]/g, "_")}"`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(Buffer.from(bytes));
  });

  /** Admin completes I-9 Section 2 after examining the employee's documents. */
  app.post<{ Params: { id: string } }>("/:id/i9-section-2", { preHandler: requireRole("admin") }, async (req) => {
    const form = await loadForm(req, req.params.id);
    if (form.type !== "i9" || form.supersededAt) throw new HttpError(400, "This isn't the employee's current I-9");
    if (form.status === "completed") throw new HttpError(409, "Section 2 is already complete");
    if (form.employeeId === req.user.sub) throw new HttpError(403, "Someone else must verify your own I-9");
    const data = parse(i9Section2Schema, req.body);
    const [row] = await db
      .update(taxForms)
      .set({
        status: "completed",
        employerData: seal(data),
        employerSignedName: data.signedName,
        employerSignedAt: new Date(),
        employerSignedById: req.user.sub,
      })
      .where(eq(taxForms.id, form.id))
      .returning();
    const tasks = await db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.employeeId, form.employeeId), eq(onboardingTasks.formType, "i9_section2"), isNull(onboardingTasks.completedAt)));
    for (const t of tasks) await completeTask(t, req.user.sub);
    return listItem(row);
  });

  /** Manual payroll: mark a W-4 or direct deposit form as entered in the payroll system. */
  app.post<{ Params: { id: string } }>("/:id/processed", { preHandler: requireRole("admin") }, async (req) => {
    const form = await loadForm(req, req.params.id);
    const [row] = await db
      .update(taxForms)
      .set({ processedAt: new Date(), processedById: req.user.sub })
      .where(eq(taxForms.id, form.id))
      .returning();
    return listItem(row);
  });
};

export default routes;
