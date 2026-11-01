import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { hasRole, isInactive, payScheduleSchema, upcomingPeriods, type PayFrequency } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, payPeriodApprovers, payPeriods } from "../db/schema";
import { authenticate, requireRole, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { notify, staffWithRole } from "../lib/notify";
import { buildPayrollLines } from "../lib/payroll";
import { localParts } from "../lib/tz";

/** Which area of the Permissions page controls access here. */
const AREA = "payroll" as const;

async function approverIds(companyId: string) {
  const rows = await db.select({ id: payPeriodApprovers.employeeId }).from(payPeriodApprovers).where(eq(payPeriodApprovers.companyId, companyId));
  return rows.map((r) => r.id);
}

/** Admins see pay periods; approvers see the ones they're asked to approve. */
async function canSeePeriods(req: FastifyRequest) {
  return hasRole(roleIn(req, AREA), "admin") || (await approverIds(req.user.companyId)).includes(req.user.sub);
}

async function schedule(companyId: string) {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  const approvers = await approverIds(companyId);
  const today = localParts(new Date(), c.timezone).date;
  const s = c.payFrequency ? { frequency: c.payFrequency as PayFrequency, anchorDate: c.payPeriodAnchor, paydayOffsetDays: c.paydayOffsetDays } : null;
  return {
    frequency: c.payFrequency as PayFrequency | null,
    anchorDate: c.payPeriodAnchor,
    paydayOffsetDays: c.paydayOffsetDays,
    approverIds: approvers,
    timezone: c.timezone,
    upcoming: s ? upcomingPeriods(today, s, 4) : [],
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/schedule", { preHandler: requireRole("admin", AREA) }, async (req) => schedule(req.user.companyId));

  /** The owner sets how often people are paid, when payday is, and who approves each period. */
  app.put("/schedule", { preHandler: requireRole("owner", AREA) }, async (req) => {
    const body = parse(payScheduleSchema, req.body);
    const ids = [...new Set(body.approverIds)];
    const valid = ids.length
      ? await db.select({ id: employees.id, status: employees.status }).from(employees).where(and(eq(employees.companyId, req.user.companyId), inArray(employees.id, ids)))
      : [];
    if (valid.length !== ids.length) notFound("Employee");
    if (valid.some((v) => isInactive(v.status))) throw new HttpError(400, "Inactive or terminated people can't approve pay periods");
    await db.transaction(async (tx) => {
      await tx
        .update(companies)
        .set({ payFrequency: body.frequency, payPeriodAnchor: body.frequency === "weekly" || body.frequency === "biweekly" ? body.anchorDate ?? null : null, paydayOffsetDays: body.paydayOffsetDays })
        .where(eq(companies.id, req.user.companyId));
      await tx.delete(payPeriodApprovers).where(eq(payPeriodApprovers.companyId, req.user.companyId));
      if (ids.length) await tx.insert(payPeriodApprovers).values(ids.map((employeeId) => ({ companyId: req.user.companyId, employeeId })));
    });
    return schedule(req.user.companyId);
  });

  /** For the sidebar: is this person an approver, and how many periods are waiting. */
  app.get("/me", async (req) => {
    const isApprover = (await approverIds(req.user.companyId)).includes(req.user.sub);
    if (!isApprover && !hasRole(roleIn(req, AREA), "owner")) return { isApprover: false, pending: 0 };
    const waiting = await db.select({ id: payPeriods.id }).from(payPeriods).where(and(eq(payPeriods.companyId, req.user.companyId), eq(payPeriods.status, "pending")));
    return { isApprover, pending: waiting.length };
  });

  /** Recent pay periods (newest first), and whether this person can approve them. */
  app.get("/", async (req) => {
    if (!(await canSeePeriods(req))) throw new HttpError(403, "You don't approve pay periods");
    const rows = await db
      .select({ period: payPeriods, approver: { firstName: employees.firstName, lastName: employees.lastName } })
      .from(payPeriods)
      .leftJoin(employees, eq(employees.id, payPeriods.approvedById))
      .where(eq(payPeriods.companyId, req.user.companyId))
      .orderBy(desc(payPeriods.periodStart))
      .limit(26);
    const isApprover = (await approverIds(req.user.companyId)).includes(req.user.sub);
    return {
      canApprove: isApprover || hasRole(roleIn(req, AREA), "owner"),
      periods: rows.map((r) => ({ ...r.period, approvedBy: r.approver?.firstName ? `${r.approver.firstName} ${r.approver.lastName}` : null })),
    };
  });

  /** One period with everyone's hours and estimated pay, for the approval page. */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    if (!(await canSeePeriods(req))) throw new HttpError(403, "You don't approve pay periods");
    const [row] = await db
      .select({ period: payPeriods, approver: { firstName: employees.firstName, lastName: employees.lastName } })
      .from(payPeriods)
      .leftJoin(employees, eq(employees.id, payPeriods.approvedById))
      .where(and(eq(payPeriods.id, req.params.id), eq(payPeriods.companyId, req.user.companyId)));
    if (!row) notFound("Pay period");
    const lines = await buildPayrollLines(db, req.user.companyId, { periodStart: row.period.periodStart, periodEnd: row.period.periodEnd });
    const isApprover = (await approverIds(req.user.companyId)).includes(req.user.sub);
    return {
      ...row.period,
      approvedBy: row.approver?.firstName ? `${row.approver.firstName} ${row.approver.lastName}` : null,
      canApprove: isApprover || hasRole(roleIn(req, AREA), "owner"),
      lines: lines.filter((l) => l.totalHours > 0 || l.ptoHours > 0 || l.payType === "salary"),
    };
  });

  /** An approver (or the owner) signs off on the period's hours; admins are told. */
  app.post<{ Params: { id: string } }>("/:id/approve", async (req) => {
    const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});
    const isApprover = (await approverIds(req.user.companyId)).includes(req.user.sub);
    if (!isApprover && !hasRole(roleIn(req, AREA), "owner")) throw new HttpError(403, "You aren't an approver for pay periods");
    const [period] = await db.select().from(payPeriods).where(and(eq(payPeriods.id, req.params.id), eq(payPeriods.companyId, req.user.companyId)));
    if (!period) notFound("Pay period");
    if (period.status === "approved") throw new HttpError(409, "This pay period is already approved");
    const [updated] = await db
      .update(payPeriods)
      .set({ status: "approved", approvedById: req.user.sub, approvedAt: new Date(), approvalNote: note || null })
      .where(and(eq(payPeriods.id, period.id), eq(payPeriods.status, "pending")))
      .returning();
    if (!updated) throw new HttpError(409, "This pay period is already approved");
    const [me] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, req.user.sub));
    notify(req.user.companyId, (await staffWithRole(req.user.companyId, "admin", AREA)).filter((id) => id !== req.user.sub), {
      category: "payroll",
      title: `Pay period ${period.periodStart} – ${period.periodEnd} approved`,
      body: `${me.f} ${me.l} approved it${note ? `: "${note}"` : ""}. Payday is ${period.payday}.`,
      link: { screen: "pay-period", id: period.id },
    });
    return updated;
  });

  /** Admins can reopen an approved period (e.g. hours were corrected) so it's approved again. */
  app.post<{ Params: { id: string } }>("/:id/reopen", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const [updated] = await db
      .update(payPeriods)
      .set({ status: "pending", approvedById: null, approvedAt: null, approvalNote: null })
      .where(and(eq(payPeriods.id, req.params.id), eq(payPeriods.companyId, req.user.companyId)))
      .returning();
    if (!updated) notFound("Pay period");
    notify(req.user.companyId, (await approverIds(req.user.companyId)).filter((id) => id !== req.user.sub), {
      category: "payroll",
      title: `Pay period ${updated.periodStart} – ${updated.periodEnd} needs approval again`,
      body: "It was reopened, e.g. because hours were corrected.",
      link: { screen: "pay-period", id: updated.id },
    });
    return updated;
  });
};

export default routes;
