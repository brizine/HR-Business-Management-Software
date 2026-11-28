import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  areaNames, customerName, formatAddress, lineAmount, lineTaxRate, packageSchema, packageToLines, propertyPackageSchema, propertyPackageUpdateSchema, roundMissed, taxRateFor, withAreaNote,
  type PackageInput, type PropertyPackageStatus,
} from "@crewdesk/shared";
import { db } from "../db";
import { crewMembers, crews, customers, packageLines, packages, properties, propertyAssignments, propertyPackageRounds, propertyPackages, serviceTypes, visitAssignees, visitLines, visits } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { propertyInCompany, type Tx } from "../lib/crm";
import { fieldsFor, jobSources, newRecordCustom } from "../lib/customFields";
import { HttpError, notFound, parse } from "../lib/errors";
import { billingSettings } from "../lib/invoices";
import { companyToday } from "../lib/payRates";
import { autoFormIds, formsFor, syncVisitForms } from "../lib/visitForms";
import { nextVisitNumber } from "./visits";

const AREA = "customers" as const;

type Round = typeof packageLines.$inferSelect;
type Enrollment = typeof propertyPackages.$inferSelect;

const roundView = (l: Round) => ({
  id: l.id, name: l.description, description: l.description, serviceTypeId: l.serviceTypeId, quantity: l.quantity, startDate: l.startDate, endDate: l.endDate,
  minDays: l.minDays, budgetedHours: l.budgetedHours, unitPriceCents: l.unitPriceCents, notes: l.notes,
});
const span = (rounds: Round[]) => {
  const starts = rounds.map((r) => r.startDate).filter((d): d is string => !!d).sort();
  const ends = rounds.map((r) => r.endDate).filter((d): d is string => !!d).sort();
  return { startDate: starts[0] ?? null, endDate: ends[ends.length - 1] ?? null };
};

/** Packages with their rounds, the season they cover and how many properties are on each. */
async function packageList(companyId: string, all: boolean, id?: string) {
  const rows = await db.select().from(packages).where(and(eq(packages.companyId, companyId), ...(all ? [] : [eq(packages.active, true)]), ...(id ? [eq(packages.id, id)] : [])))
    .orderBy(asc(packages.sortOrder), asc(packages.name));
  const ids = rows.map((p) => p.id);
  const lines = ids.length ? await db.select().from(packageLines).where(inArray(packageLines.packageId, ids)).orderBy(asc(packageLines.sortOrder)) : [];
  const counts = ids.length ? await db.select({ packageId: propertyPackages.packageId, n: sql<number>`count(*)::int` }).from(propertyPackages)
    .where(and(inArray(propertyPackages.packageId, ids), eq(propertyPackages.status, "active"))).groupBy(propertyPackages.packageId) : [];
  return rows.map((p) => {
    const mine = lines.filter((l) => l.packageId === p.id);
    return { ...p, ...span(mine), rounds: mine.map(roundView), propertyCount: counts.find((c) => c.packageId === p.id)?.n ?? 0 };
  });
}

async function checkServices(companyId: string, body: PackageInput) {
  const svc = [...new Set(body.rounds.map((r) => r.serviceTypeId))];
  const found = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, svc)));
  if (found.length !== svc.length) throw new HttpError(400, "One of those services isn't on the price list");
}
const roundRow = (packageId: string, r: PackageInput["rounds"][number], i: number) => ({
  packageId, serviceTypeId: r.serviceTypeId, description: r.name, quantity: 1, startDate: r.startDate, endDate: r.endDate, minDays: r.minDays || null,
  budgetedHours: r.budgetedHours ?? null, unitPriceCents: r.unitPriceCents ?? null, notes: r.notes ?? null, sortOrder: i,
});

async function checkCrew(companyId: string, crewId: string | null | undefined) {
  if (!crewId) return;
  const [c] = await db.select({ id: crews.id }).from(crews).where(and(eq(crews.id, crewId), eq(crews.companyId, companyId)));
  if (!c) throw new HttpError(400, "That crew doesn't exist");
}

/** A property's packages (or a customer's, or everyone on one package) with each round and the work order made for it. */
async function enrollmentViews(companyId: string, by: { propertyId?: string; customerId?: string; packageId?: string; id?: string }) {
  const where = [eq(propertyPackages.companyId, companyId)];
  if (by.id) where.push(eq(propertyPackages.id, by.id));
  if (by.propertyId) where.push(eq(propertyPackages.propertyId, by.propertyId));
  if (by.customerId) where.push(eq(propertyPackages.customerId, by.customerId));
  if (by.packageId) where.push(eq(propertyPackages.packageId, by.packageId));
  const rows = await db.select({ e: propertyPackages, p: properties, c: customers, crewName: crews.name, crewColor: crews.color }).from(propertyPackages)
    .innerJoin(properties, eq(properties.id, propertyPackages.propertyId)).innerJoin(customers, eq(customers.id, propertyPackages.customerId))
    .leftJoin(crews, eq(crews.id, propertyPackages.crewId))
    .where(and(...where)).orderBy(desc(propertyPackages.createdAt)).limit(2000);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.e.id);
  const rounds = await db.select({ r: propertyPackageRounds, l: packageLines, service: serviceTypes.name }).from(propertyPackageRounds)
    .innerJoin(packageLines, eq(packageLines.id, propertyPackageRounds.roundId)).leftJoin(serviceTypes, eq(serviceTypes.id, packageLines.serviceTypeId))
    .where(inArray(propertyPackageRounds.propertyPackageId, ids)).orderBy(asc(packageLines.sortOrder));
  const today = await companyToday(companyId);
  const made = await db.select({ id: visits.id, number: visits.number, status: visits.status, date: visits.date, totalCents: visits.totalCents, propertyPackageId: visits.propertyPackageId, packageRoundId: visits.packageRoundId, createdAt: visits.createdAt })
    .from(visits).where(inArray(visits.propertyPackageId, ids)).orderBy(desc(visits.createdAt));
  return rows.map(({ e, p, c, crewName, crewColor }) => {
    const mine = rounds.filter((x) => x.r.propertyPackageId === e.id).map(({ r, l, service }) => {
      const v = made.find((x) => x.propertyPackageId === e.id && x.packageRoundId === l.id);
      return {
        roundId: l.id, name: l.description, service, startDate: l.startDate, endDate: l.endDate, minDays: l.minDays, included: r.included, quantity: r.quantity,
        unitPriceCents: r.unitPriceCents, budgetedHours: r.budgetedHours,
        // A round that was missed (its window ended with no work order) isn't part of this season's total.
        amountCents: r.included && r.unitPriceCents != null && (v || !roundMissed(l, today)) ? lineAmount({ quantity: r.quantity, unitPriceCents: r.unitPriceCents }) : 0,
        visit: v ? { id: v.id, number: v.number, status: v.status, date: v.date, totalCents: v.totalCents } : null,
      };
    });
    return {
      id: e.id, propertyId: e.propertyId, packageId: e.packageId, packageName: e.packageName, renewal: e.renewal, status: e.status as PropertyPackageStatus, notes: e.notes, startedOn: e.startedOn,
      pausedAt: e.pausedAt, cancelledAt: e.cancelledAt, crew: e.crewId ? { id: e.crewId, name: crewName ?? "", color: crewColor ?? "#2563eb" } : null,
      property: { id: p.id, address: formatAddress(p), mapCode: p.mapCode }, customer: { id: c.id, name: customerName(c) },
      rounds: mine, totalCents: mine.reduce((s, r) => s + r.amountCents, 0),
    };
  });
}

/**
 * Makes the waiting-list work orders for a property's rounds: each is eligible from the round's
 * start, due by its end, with the round's minimum days since the last service. A round that's
 * being caught up after its window (`missed`) has no window, so it can go out right away.
 */
async function makeRoundVisits(tx: Tx, o: {
  companyId: string; me: string; enrollment: Enrollment;
  items: { round: Round; quantity: number; unitPriceCents: number; budgetedHours: number | null; missed: boolean }[];
}) {
  if (!o.items.length) return 0;
  const { companyId, enrollment: e } = o;
  const [property] = await tx.select().from(properties).where(eq(properties.id, e.propertyId));
  const [customer] = await tx.select().from(customers).where(eq(customers.id, e.customerId));
  const svcIds = [...new Set(o.items.map((i) => i.round.serviceTypeId).filter((x): x is string => !!x))];
  const services = svcIds.length ? await tx.select().from(serviceTypes).where(inArray(serviceTypes.id, svcIds)) : [];
  const rate = taxRateFor({ settings: await billingSettings(companyId, tx), customer, property });
  const names = areaNames(await fieldsFor(companyId, "property"));
  const custom = await newRecordCustom(companyId, "workorder", undefined, await jobSources(companyId, e.propertyId, e.customerId));
  // The crew's people go on each work order, as when a crew is picked on the work order form.
  const people = e.crewId ? [...new Set([
    ...(await tx.select({ id: crews.leadId }).from(crews).where(eq(crews.id, e.crewId))).map((r) => r.id).filter((x): x is string => !!x),
    ...(await tx.select({ id: crewMembers.employeeId }).from(crewMembers).where(eq(crewMembers.crewId, e.crewId))).map((r) => r.id),
  ])] : [];
  let number = await nextVisitNumber(tx, companyId);
  for (const item of o.items) {
    const s = services.find((x) => x.id === item.round.serviceTypeId);
    // Priced from the part of the lawn the service covers (front, back…), and the line says so.
    const [line] = packageToLines([{ serviceTypeId: s?.id ?? null, description: s?.name ?? item.round.description, quantity: item.quantity, budgetedHours: item.budgetedHours, unitPriceCents: item.unitPriceCents }], services as never, property);
    const amountCents = lineAmount({ quantity: item.quantity, unitPriceCents: item.unitPriceCents });
    const [v] = await tx.insert(visits).values({
      companyId, number: number++, title: item.round.description, customerId: e.customerId, propertyId: e.propertyId, billing: "invoice", crewId: e.crewId,
      date: null, waitingSince: new Date(), notes: item.round.notes, budgetedHours: item.budgetedHours || null, totalCents: amountCents,
      releaseOn: item.missed ? null : item.round.startDate, dueBy: item.missed ? null : item.round.endDate, minDaysAfterLast: item.round.minDays || null,
      propertyPackageId: e.id, packageRoundId: item.round.id, custom, createdById: o.me,
    }).returning({ id: visits.id });
    await tx.insert(visitLines).values({
      visitId: v.id, serviceTypeId: s?.id ?? null, description: withAreaNote(line.description, line, names), quantity: item.quantity, budgetedHours: item.budgetedHours,
      unitPriceCents: item.unitPriceCents, amountCents, taxRate: lineTaxRate(s?.taxable, rate), lawnArea: line.lawnArea, lawnAreaSqFt: null, sortOrder: 0,
    });
    if (people.length) await tx.insert(visitAssignees).values(people.map((employeeId) => ({ visitId: v.id, employeeId })));
    const forms = await formsFor(companyId, await autoFormIds(companyId, s ? [s.id] : []));
    if (forms.length) await syncVisitForms(tx, companyId, [v.id], forms);
  }
  return o.items.length;
}

/** The rounds' work orders that haven't been given a date yet (and aren't invoiced): the ones a pause or a cancel takes back. */
const waitingOnly = (enrollmentId: string) => and(eq(visits.propertyPackageId, enrollmentId), eq(visits.status, "open"), isNull(visits.date), isNull(visits.invoiceId));

/**
 * Packages: season programs. Customers & billing managers put them on properties; admins (who keep
 * the price list) change the packages themselves.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get<{ Querystring: { all?: string } }>("/", async (req) => packageList(req.user.companyId, req.query.all === "1"));

  /** One package with the properties on it. */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const [p] = await packageList(req.user.companyId, true, req.params.id);
    if (!p) notFound("Package");
    const on = await enrollmentViews(req.user.companyId, { packageId: p.id });
    return { ...p, properties: on.map((e) => ({ id: e.id, status: e.status, renewal: e.renewal, property: e.property, customer: e.customer, crew: e.crew, totalCents: e.totalCents })) };
  });

  app.post("/", admin, async (req) => {
    const body = parse(packageSchema, req.body);
    await checkServices(req.user.companyId, body);
    const id = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: max(packages.sortOrder) }).from(packages).where(eq(packages.companyId, req.user.companyId));
      const [p] = await tx.insert(packages).values({ companyId: req.user.companyId, name: body.name, description: body.description ?? null, renewalDate: body.renewalDate ?? null, active: body.active, sortOrder: (n ?? -1) + 1 }).returning();
      await tx.insert(packageLines).values(body.rounds.map((r, i) => roundRow(p.id, r, i)));
      return p.id;
    });
    return (await packageList(req.user.companyId, true, id))[0];
  });

  /**
   * Rounds keep their ids, so work orders already made stay linked. A round's new window also moves
   * its work orders still on the waiting list; ones with a date, and every price, are left alone.
   */
  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const body = parse(packageSchema, req.body);
    const [p] = await db.select().from(packages).where(and(eq(packages.id, req.params.id), eq(packages.companyId, req.user.companyId)));
    if (!p) notFound("Package");
    await checkServices(req.user.companyId, body);
    const moved = await db.transaction(async (tx) => {
      await tx.update(packages).set({ name: body.name, description: body.description ?? null, renewalDate: body.renewalDate ?? null, active: body.active }).where(eq(packages.id, p.id));
      const have = await tx.select().from(packageLines).where(eq(packageLines.packageId, p.id));
      const kept = new Set(body.rounds.map((r) => r.id).filter((x): x is string => !!x && have.some((h) => h.id === x)));
      const gone = have.filter((h) => !kept.has(h.id)).map((h) => h.id);
      if (gone.length) await tx.delete(packageLines).where(inArray(packageLines.id, gone));
      let moved = 0;
      for (const [i, r] of body.rounds.entries()) {
        const row = roundRow(p.id, r, i);
        const old = r.id ? have.find((h) => h.id === r.id) : undefined;
        if (!old) { await tx.insert(packageLines).values(row); continue; }
        await tx.update(packageLines).set(row).where(eq(packageLines.id, old.id));
        if (old.startDate !== row.startDate || old.endDate !== row.endDate || (old.minDays ?? null) !== row.minDays) {
          // Not the ones caught up after their window (no window at all): they're due now.
          moved += (await tx.update(visits).set({ releaseOn: row.startDate, dueBy: row.endDate, minDaysAfterLast: row.minDays, updatedAt: new Date() })
            .where(and(eq(visits.packageRoundId, old.id), eq(visits.companyId, req.user.companyId), eq(visits.status, "open"), isNull(visits.date), sql`${visits.releaseOn} is not null`)).returning({ id: visits.id })).length;
        }
      }
      if (body.name !== p.name) await tx.update(propertyPackages).set({ packageName: body.name }).where(and(eq(propertyPackages.packageId, p.id), ne(propertyPackages.status, "cancelled")));
      return moved;
    });
    return { ...(await packageList(req.user.companyId, true, p.id))[0], movedWorkOrders: moved };
  });

  /** A new package with the same rounds, to change for another program or next season. */
  app.post<{ Params: { id: string } }>("/:id/copy", admin, async (req) => {
    const [p] = await db.select().from(packages).where(and(eq(packages.id, req.params.id), eq(packages.companyId, req.user.companyId)));
    if (!p) notFound("Package");
    const id = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: max(packages.sortOrder) }).from(packages).where(eq(packages.companyId, req.user.companyId));
      const [copy] = await tx.insert(packages).values({ companyId: p.companyId, name: `${p.name} (copy)`.slice(0, 120), description: p.description, renewalDate: p.renewalDate, active: p.active, sortOrder: (n ?? -1) + 1 }).returning();
      const lines = await tx.select().from(packageLines).where(eq(packageLines.packageId, p.id)).orderBy(asc(packageLines.sortOrder));
      if (lines.length) await tx.insert(packageLines).values(lines.map(({ id: _id, packageId: _p, ...l }) => ({ ...l, packageId: copy.id })));
      return copy.id;
    });
    return (await packageList(req.user.companyId, true, id))[0];
  });

  /** Only a package no property is on: otherwise make it inactive, which keeps what's running. */
  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const [p] = await db.select().from(packages).where(and(eq(packages.id, req.params.id), eq(packages.companyId, req.user.companyId)));
    if (!p) notFound("Package");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(propertyPackages).where(and(eq(propertyPackages.packageId, p.id), ne(propertyPackages.status, "cancelled")));
    if (n) throw new HttpError(400, `${n} ${n === 1 ? "property is" : "properties are"} on this package. Make it inactive instead, or cancel it on ${n === 1 ? "that property" : "those properties"} first.`);
    await db.delete(packages).where(eq(packages.id, p.id));
    return { ok: true };
  });

  app.put("/order", admin, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(500) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(packages).set({ sortOrder: i }).where(and(eq(packages.id, id), eq(packages.companyId, req.user.companyId)));
    });
    return { ok: true };
  });

  // ---- Packages on properties ----

  app.get<{ Querystring: { propertyId?: string; customerId?: string } }>("/enrollments", async (req) => {
    const { propertyId, customerId } = req.query;
    if (!propertyId && !customerId) throw new HttpError(400, "Say which property or customer");
    return { today: await companyToday(req.user.companyId), items: await enrollmentViews(req.user.companyId, { propertyId, customerId }) };
  });

  /** Puts a package on a property and makes a waiting-list work order for each round it gets. */
  app.post("/enrollments", async (req) => {
    const body = parse(propertyPackageSchema, req.body);
    const { companyId, sub: me } = req.user;
    const property = await propertyInCompany(db, companyId, body.propertyId);
    if (property.status === "cancelled") throw new HttpError(400, "That property is inactive");
    const [billTo] = await db.select({ customerId: propertyAssignments.customerId }).from(propertyAssignments)
      .where(and(eq(propertyAssignments.propertyId, property.id), eq(propertyAssignments.role, "bill_to"), isNull(propertyAssignments.endDate)));
    if (!billTo) throw new HttpError(400, "This property has no bill-to customer yet. Add one first, so the rounds can be invoiced.");
    const [pkg] = await db.select().from(packages).where(and(eq(packages.id, body.packageId), eq(packages.companyId, companyId)));
    if (!pkg) notFound("Package");
    if (!pkg.active) throw new HttpError(400, "That package is inactive");
    const [dup] = await db.select({ id: propertyPackages.id }).from(propertyPackages).where(and(eq(propertyPackages.propertyId, property.id), eq(propertyPackages.packageId, pkg.id), ne(propertyPackages.status, "cancelled")));
    if (dup) throw new HttpError(400, `This property is already on ${pkg.name}`);
    await checkCrew(companyId, body.crewId);
    const rounds = await db.select().from(packageLines).where(eq(packageLines.packageId, pkg.id)).orderBy(asc(packageLines.sortOrder));
    if (body.rounds.some((r) => !rounds.some((x) => x.id === r.roundId))) throw new HttpError(400, "The package's rounds have changed. Reload and try again.");
    const today = await companyToday(companyId);
    const picks = rounds.map((round) => ({ round, pick: body.rounds.find((r) => r.roundId === round.id) }));
    const result = await db.transaction(async (tx) => {
      const [e] = await tx.insert(propertyPackages).values({
        companyId, propertyId: property.id, customerId: billTo.customerId, packageId: pkg.id, packageName: pkg.name, renewal: body.renewal, crewId: body.crewId ?? null,
        notes: body.notes ?? null, startedOn: today, createdById: me,
      }).returning();
      await tx.insert(propertyPackageRounds).values(picks.map(({ round, pick }) => ({
        propertyPackageId: e.id, roundId: round.id, included: !!pick?.include, quantity: pick?.quantity ?? 1, unitPriceCents: pick?.unitPriceCents ?? null, budgetedHours: pick?.budgetedHours ?? round.budgetedHours ?? null,
      })));
      const items = picks.filter(({ round, pick }) => pick?.include && (!roundMissed(round, today) || pick.scheduleMissed))
        .map(({ round, pick }) => ({ round, quantity: pick!.quantity, unitPriceCents: pick!.unitPriceCents!, budgetedHours: pick!.budgetedHours ?? round.budgetedHours ?? null, missed: roundMissed(round, today) }));
      return { id: e.id, created: await makeRoundVisits(tx, { companyId, me, enrollment: e, items }) };
    });
    return { ...(await enrollmentViews(companyId, { id: result.id }))[0], created: result.created };
  });

  async function findEnrollment(companyId: string, id: string) {
    const [e] = await db.select().from(propertyPackages).where(and(eq(propertyPackages.id, id), eq(propertyPackages.companyId, companyId)));
    if (!e) notFound("Package");
    return e;
  }

  /** How it renews, the crew and the notes. A new crew also goes on its work orders still on the waiting list. */
  app.put<{ Params: { id: string } }>("/enrollments/:id", async (req) => {
    const body = parse(propertyPackageUpdateSchema, req.body);
    const { companyId } = req.user;
    const e = await findEnrollment(companyId, req.params.id);
    await checkCrew(companyId, body.crewId);
    const crewId = body.crewId ?? null;
    await db.transaction(async (tx) => {
      await tx.update(propertyPackages).set({ renewal: body.renewal, crewId, notes: body.notes ?? null, updatedAt: new Date() }).where(eq(propertyPackages.id, e.id));
      if (crewId === e.crewId) return;
      const open = (await tx.update(visits).set({ crewId, updatedAt: new Date() }).where(waitingOnly(e.id)).returning({ id: visits.id })).map((v) => v.id);
      if (!open.length) return;
      const people = crewId ? [...new Set([
        ...(await tx.select({ id: crews.leadId }).from(crews).where(eq(crews.id, crewId))).map((r) => r.id).filter((x): x is string => !!x),
        ...(await tx.select({ id: crewMembers.employeeId }).from(crewMembers).where(eq(crewMembers.crewId, crewId))).map((r) => r.id),
      ])] : [];
      await tx.delete(visitAssignees).where(inArray(visitAssignees.visitId, open));
      if (people.length) await tx.insert(visitAssignees).values(open.flatMap((visitId) => people.map((employeeId) => ({ visitId, employeeId }))));
    });
    return (await enrollmentViews(companyId, { id: e.id }))[0];
  });

  /**
   * Pause or cancel: the rounds still on the waiting list are taken off it. Work orders that already
   * have a date (or are done, or invoiced) stay; `stillScheduled` says how many are left to look at.
   */
  const stop = (status: "paused" | "cancelled") => async (req: { user: { companyId: string }; params: { id: string } }) => {
    const { companyId } = req.user;
    const e = await findEnrollment(companyId, req.params.id);
    if (e.status === "cancelled") throw new HttpError(400, "This package is already cancelled");
    if (e.status === status) throw new HttpError(400, "This package is already paused");
    const removed = await db.transaction(async (tx) => {
      await tx.update(propertyPackages).set({ status, ...(status === "paused" ? { pausedAt: new Date() } : { cancelledAt: new Date() }), updatedAt: new Date() }).where(eq(propertyPackages.id, e.id));
      return (await tx.delete(visits).where(waitingOnly(e.id)).returning({ id: visits.id })).length;
    });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(visits).where(and(eq(visits.propertyPackageId, e.id), inArray(visits.status, ["open", "on_site"])));
    return { ...(await enrollmentViews(companyId, { id: e.id }))[0], removed, stillScheduled: n };
  };
  app.post<{ Params: { id: string } }>("/enrollments/:id/pause", stop("paused"));
  app.post<{ Params: { id: string } }>("/enrollments/:id/cancel", stop("cancelled"));

  /** Back on: the included rounds that have no work order and whose window hasn't ended go back on the waiting list. */
  app.post<{ Params: { id: string } }>("/enrollments/:id/resume", async (req) => {
    const { companyId, sub: me } = req.user;
    const e = await findEnrollment(companyId, req.params.id);
    if (e.status !== "paused") throw new HttpError(400, "Only a paused package can be resumed");
    const today = await companyToday(companyId);
    const created = await db.transaction(async (tx) => {
      await tx.update(propertyPackages).set({ status: "active", pausedAt: null, updatedAt: new Date() }).where(eq(propertyPackages.id, e.id));
      const rounds = await tx.select({ r: propertyPackageRounds, round: packageLines }).from(propertyPackageRounds).innerJoin(packageLines, eq(packageLines.id, propertyPackageRounds.roundId))
        .where(and(eq(propertyPackageRounds.propertyPackageId, e.id), eq(propertyPackageRounds.included, true))).orderBy(asc(packageLines.sortOrder));
      const have = new Set((await tx.select({ id: visits.packageRoundId }).from(visits).where(eq(visits.propertyPackageId, e.id))).map((v) => v.id));
      const items = rounds.filter(({ r, round }) => !have.has(round.id) && !roundMissed(round, today) && r.unitPriceCents != null)
        .map(({ r, round }) => ({ round, quantity: r.quantity, unitPriceCents: r.unitPriceCents!, budgetedHours: r.budgetedHours, missed: false }));
      return makeRoundVisits(tx, { companyId, me, enrollment: { ...e, status: "active" }, items });
    });
    return { ...(await enrollmentViews(companyId, { id: e.id }))[0], created };
  });
};

export default routes;
