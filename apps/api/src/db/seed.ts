/**
 * Demo data: one company with staff, PTO, a job opening, an onboarding
 * template and a small fleet with maintenance schedules.
 * Sign in as owner@demo.test / password123 (or tech@demo.test for an employee).
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "./index";
import * as s from "./schema";
import { storage } from "../lib/storage";

const existing = await db.select().from(s.employees).where(eq(s.employees.email, "owner@demo.test"));
if (existing.length) {
  console.log("Demo data already present");
  await pool.end();
  process.exit(0);
}

const hash = await bcrypt.hash("password123", 10);
// Two-factor is optional in the demo so you can click straight in; real companies default to requiring it for owners and admins.
const [company] = await db
  .insert(s.companies)
  .values({ name: "Demo Landscaping & Haul", twoFactorRequiredFor: "none", legalName: "Demo Landscaping & Haul LLC", ein: "12-3456789", address: "100 Congress Ave, Austin, TX 78701" })
  .returning();
const companyId = company.id;

const [owner] = await db
  .insert(s.employees)
  .values({ companyId, firstName: "Olivia", lastName: "Owner", email: "owner@demo.test", passwordHash: hash, role: "owner", payType: "salary", payRateCents: 9_500_000, title: "Owner" })
  .returning();
const [mgr] = await db
  .insert(s.employees)
  .values({ companyId, firstName: "Marcus", lastName: "Manager", email: "manager@demo.test", passwordHash: hash, role: "manager", payRateCents: 3200, title: "Crew Lead", department: "Field", managerId: owner.id })
  .returning();
const [tech] = await db
  .insert(s.employees)
  .values({ companyId, firstName: "Tina", lastName: "Tech", email: "tech@demo.test", passwordHash: hash, role: "employee", payRateCents: 2400, title: "Mechanic", department: "Shop", managerId: mgr.id })
  .returning();
const [crew] = await db
  .insert(s.employees)
  .values({ companyId, firstName: "Carlos", lastName: "Crew", email: "crew@demo.test", passwordHash: hash, role: "employee", payRateCents: 2000, title: "Driver", department: "Field", managerId: mgr.id })
  .returning();

const [pto] = await db.insert(s.ptoPolicies).values({ companyId, name: "Paid Time Off", accrualRate: 1 / 30, maxBalanceHours: 80 }).returning();
const [sick] = await db.insert(s.ptoPolicies).values({ companyId, name: "Sick Leave", annualGrantHours: 40 }).returning();
for (const e of [owner, mgr, tech, crew]) {
  await db.insert(s.ptoLedger).values([
    { companyId, employeeId: e.id, policyId: pto.id, hours: 24, reason: "starting balance" },
    { companyId, employeeId: e.id, policyId: sick.id, hours: 40, reason: "annual grant" },
  ]);
}
await db.insert(s.ptoRequests).values({ companyId, employeeId: crew.id, policyId: pto.id, startDate: "2026-12-22", endDate: "2026-12-23", hours: 16, reason: "Holiday travel" });

// Last week's time entries for the hourly crew.
const monday = new Date();
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
for (const e of [mgr, tech, crew]) {
  for (let d = 0; d < 5; d++) {
    const day = new Date(monday.getTime() + d * 86_400_000);
    const inAt = new Date(day.setUTCHours(13, 0, 0, 0));
    const outAt = new Date(inAt.getTime() + (e.id === crew.id ? 9.5 : 8.5) * 3_600_000);
    await db.insert(s.timeEntries).values({ companyId, employeeId: e.id, clockIn: inAt, clockOut: outAt });
  }
}

const [job] = await db
  .insert(s.jobs)
  .values({ companyId, title: "CDL Truck Driver", department: "Field", location: "Austin, TX", payRange: "$22–$28/hr", description: "Drive our dump trucks between job sites. Class B CDL required." })
  .returning();
await db.insert(s.applicants).values([
  { companyId, jobId: job.id, firstName: "Avery", lastName: "Applicant", email: "avery@example.com", stage: "applied" },
  { companyId, jobId: job.id, firstName: "Jordan", lastName: "Lee", email: "jordan@example.com", stage: "interview" },
]);

// A company handbook (stored encrypted, like any upload) that every new hire signs.
const handbookKey = `${companyId}/demo-employee-handbook.txt`;
const handbookText = "Demo Landscaping & Haul — Employee Handbook\n\n1. Safety first: wear PPE on every job site.\n2. Clock in when you arrive, out when you leave.\n3. Report equipment problems right away with the QR label on the machine.\n";
await storage.put(handbookKey, Buffer.from(handbookText));
const [handbook] = await db
  .insert(s.documents)
  .values({ companyId, name: "Employee handbook", category: "policy", storageKey: handbookKey, mimeType: "text/plain", sizeBytes: Buffer.byteLength(handbookText), uploadedById: owner.id })
  .returning();

await db.insert(s.onboardingTemplates).values({
  companyId,
  name: "Field crew onboarding",
  tasks: [
    { title: "Fill out your W-4", assignee: "employee", dueInDays: 0, action: "form", formType: "w4" },
    { title: "Fill out Form I-9 (Section 1)", assignee: "employee", dueInDays: 0, action: "form", formType: "i9" },
    { title: "Set up direct deposit", assignee: "employee", dueInDays: 1, action: "form", formType: "direct_deposit" },
    { title: "Upload a photo of your driver's license", assignee: "employee", dueInDays: 1, action: "upload" },
    { title: "Sign the employee handbook", assignee: "employee", dueInDays: 1, action: "sign", documentId: handbook.id },
    { title: "Verify I-9 documents (Section 2)", assignee: "admin", dueInDays: 3, action: "form", formType: "i9_section2" },
    { title: "Equipment safety walkthrough", assignee: "manager", dueInDays: 5, action: "none" },
  ],
});

const [truck] = await db
  .insert(s.assets)
  .values({ companyId, name: "Truck 12", type: "vehicle", make: "Ford", model: "F-550", year: 2021, vin: "1FDUF5HT0MDA00012", licensePlate: "TX-4KD-112", odometer: 48_700, engineHours: 2100, assignedEmployeeId: crew.id, registrationExpires: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) })
  .returning();
const [mower] = await db
  .insert(s.assets)
  .values({ companyId, name: "Zero-turn Mower #3", type: "small_equipment", make: "Toro", model: "Z Master 4000", year: 2023, serialNumber: "TZM-449201", engineHours: 612 })
  .returning();
const [skid] = await db
  .insert(s.assets)
  .values({ companyId, name: "Skid Steer", type: "heavy_equipment", make: "Bobcat", model: "S770", year: 2019, serialNumber: "B3BX11223", engineHours: 3_940 })
  .returning();

const [oil] = await db
  .insert(s.maintenanceSchedules)
  .values([
    { companyId, assetId: truck.id, name: "Oil & filter change", intervalMiles: 5000, intervalDays: 180, lastServiceOdometer: 44_000, lastServiceDate: "2026-06-01" },
    { companyId, assetId: truck.id, name: "Tire rotation", intervalMiles: 7500, lastServiceOdometer: 45_000 },
    { companyId, assetId: mower.id, name: "Blade sharpening", intervalHours: 50, lastServiceHours: 570 },
    { companyId, assetId: skid.id, name: "Hydraulic filter", intervalHours: 500, lastServiceHours: 3_500 },
  ])
  .returning();

await db.insert(s.workOrders).values({ companyId, number: 1001, assetId: truck.id, scheduleId: oil.id, title: "Oil & filter change", priority: "medium", assignedToId: tech.id, reportedById: mgr.id });

// This week's published schedule, plus one open shift up for grabs.
const thisMonday = new Date();
thisMonday.setUTCHours(0, 0, 0, 0);
thisMonday.setUTCDate(thisMonday.getUTCDate() - ((thisMonday.getUTCDay() + 6) % 7));
const at = (day: number, hourUtc: number) => new Date(thisMonday.getTime() + day * 86_400_000 + hourUtc * 3_600_000);
for (let d = 0; d < 5; d++) {
  await db.insert(s.shifts).values([
    { companyId, employeeId: crew.id, startsAt: at(d, 13), endsAt: at(d, 21), position: "Driver", location: "North yard", assetId: truck.id, status: "published" },
    { companyId, employeeId: tech.id, startsAt: at(d, 14), endsAt: at(d, 22), position: "Mechanic", location: "Shop", status: "published" },
    { companyId, employeeId: mgr.id, startsAt: at(d, 12), endsAt: at(d, 20), position: "Crew lead", status: "published" },
  ]);
}
await db.insert(s.shifts).values({ companyId, startsAt: at(5, 14), endsAt: at(5, 20), position: "Mower operator", location: "Riverside HOA", assetId: mower.id, status: "published" });

// Company wiki: a few pages at different access levels.
const page = async (v: Partial<typeof s.wikiPages.$inferInsert> & { title: string; body: string }) => {
  const [p] = await db.insert(s.wikiPages).values({ companyId, createdById: owner.id, updatedById: owner.id, ...v }).returning();
  await db.insert(s.wikiRevisions).values({ pageId: p.id, title: p.title, body: p.body, note: "Created", editedById: owner.id });
  return p;
};
await page({
  title: "Welcome to Demo Landscaping & Haul",
  pinned: true,
  body: "Glad you're here! Start with these:\n\n- **Safety rules** — read before your first shift\n- **Payroll calendar** — when you get paid\n- Questions? Ask your crew lead or message Olivia.\n",
});
const safety = await page({
  title: "Safety rules",
  pinned: true,
  editMin: "manager",
  body: "## Every job site\n\n1. Wear PPE: boots, gloves, eye and hearing protection.\n2. Do a **pre-trip inspection** before driving any truck (scan the QR label).\n3. Never work alone on a mower slope over 15°.\n\n## If someone is hurt\n\nCall 911 first, then your crew lead.\n",
});
await page({ title: "Ladder safety", parentId: safety.id, editMin: "manager", body: "Keep **three points of contact**. Set extension ladders at a 4:1 angle.\n" });
await page({
  title: "Payroll calendar",
  body: "We pay **every other Friday** by direct deposit.\n\n| Pay period ends | Payday |\n| --- | --- |\n| Nov 8 | Nov 14 |\n| Nov 22 | Nov 26 (Wed, holiday week) |\n| Dec 6 | Dec 12 |\n",
});
await page({ title: "Crew tips & tricks", editMin: "employee", body: "Anyone can add to this page.\n\n- Freeze a water jug overnight for hot days.\n" });
await page({ title: "Manager handbook", viewMin: "manager", editMin: "manager", body: "## Approving time\n\nApprove timesheets by **Monday noon** so payroll can run.\n" });
await page({ title: "Vendor accounts", viewMin: "admin", editMin: "admin", body: "Fuel card and parts-supplier account details. Admins only.\n" });

console.log("Seeded demo company. Sign in as owner@demo.test / password123");
await pool.end();
