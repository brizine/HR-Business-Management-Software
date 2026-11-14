import { and, eq, inArray } from "drizzle-orm";
import { rateOn, sortRates, type PayRateLike } from "@crewdesk/shared";
import { db as defaultDb, type DB } from "../db";
import { companies, employees, payRates } from "../db/schema";
import { localParts } from "./tz";

type Employee = typeof employees.$inferSelect;
export type PayRateRow = typeof payRates.$inferSelect;

/** Each person's rate history, oldest first. Anyone without one falls back to their current pay. */
export async function ratesByEmployee(db: DB, companyId: string, staff: Pick<Employee, "id" | "payType" | "payRateCents">[]) {
  const ids = staff.map((e) => e.id);
  const rows = ids.length ? await db.select().from(payRates).where(and(eq(payRates.companyId, companyId), inArray(payRates.employeeId, ids))) : [];
  const map = new Map<string, PayRateLike[]>();
  for (const e of staff) {
    const mine = sortRates(rows.filter((r) => r.employeeId === e.id));
    map.set(e.id, mine.length ? mine : [{ effectiveDate: "2000-01-01", payType: e.payType, payRateCents: e.payRateCents }]);
  }
  return map;
}

export async function companyToday(companyId: string, db: DB = defaultDb) {
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  return localParts(new Date(), c?.tz ?? "America/Chicago").date;
}

/** Someone with no history yet gets their current pay as the starting rate (covering all earlier dates). */
export async function ensureHistory(db: DB, e: Employee) {
  const [existing] = await db.select({ id: payRates.id }).from(payRates).where(eq(payRates.employeeId, e.id)).limit(1);
  if (existing) return;
  await db.insert(payRates).values({ companyId: e.companyId, employeeId: e.id, effectiveDate: e.startDate ?? "2000-01-01", payType: e.payType, payRateCents: e.payRateCents, note: "Starting rate" });
}

/** Adds (or replaces, for the same date) a rate, then updates the person's current pay. */
export async function setRate(db: DB, e: Employee, rate: { effectiveDate: string; payType: string; payRateCents: number; note?: string | null }, by: string | null) {
  await ensureHistory(db, e);
  const values = { companyId: e.companyId, employeeId: e.id, effectiveDate: rate.effectiveDate, payType: rate.payType, payRateCents: rate.payRateCents, note: rate.note || null, createdById: by };
  await db.insert(payRates).values(values).onConflictDoUpdate({ target: [payRates.employeeId, payRates.effectiveDate], set: values });
  return syncCurrentPay(db, e.id, await companyToday(e.companyId, db));
}

/** employees.payType / payRateCents mirror the rate in effect today (raises dated in the future apply on their day). */
export async function syncCurrentPay(db: DB, employeeId: string, today: string) {
  const rows = await db.select().from(payRates).where(eq(payRates.employeeId, employeeId));
  const current = rateOn(rows, today);
  if (!current) return null;
  const [e] = await db.update(employees).set({ payType: current.payType, payRateCents: current.payRateCents }).where(eq(employees.id, employeeId)).returning();
  return e;
}
