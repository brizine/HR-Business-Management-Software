/** Tax forms collected in Crewdesk, and manual payroll export. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { taxForms } from "../src/db/schema";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";
import { ptoHoursInPeriod } from "../src/lib/payroll";

let app: FastifyInstance;
let pushes: PushMessage[] = [];
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@tax.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who?: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  const json = res.headers["content-type"]?.includes("json");
  return { status: res.statusCode, body: json ? res.json() : res.body, raw: res.rawPayload, headers: res.headers };
}

const W4 = {
  firstName: "Tess", lastName: "Taxpayer", address: "12 Elm St", city: "Austin", state: "TX", zip: "78701",
  ssn: "123456789", filingStatus: "married_jointly", childrenAmount: 4400, extraWithholding: 25, signedName: "Tess Taxpayer",
};
const I9 = {
  lastName: "Taxpayer", firstName: "Tess", address: "12 Elm St", city: "Austin", state: "TX", zip: "78701",
  dateOfBirth: "1992-03-14", ssn: "123-45-6789", citizenship: "citizen", signedName: "Tess Taxpayer",
};
const DD = { bankName: "Chase", routingNumber: "021000021", accountNumber: "000123456789", accountNumberConfirm: "000123456789", accountType: "checking", signedName: "Tess Taxpayer" };

beforeAll(async () => {
  setEmailTransport(null);
  setSmsTransport(null);
  setPushTransport({ send: async (m) => (pushes.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Tax Co", firstName: "Oscar", lastName: "Owner", email: email("owner"), password: "password123",
  });
  T.owner = signup.body.token;
  ID.owner = signup.body.user.id;
  await call("POST", "/notifications/devices", "owner", { token: `ExponentPushToken[owner-${suffix}]`, platform: "ios" });
  for (const [who, role] of [["tess", "employee"], ["mgr", "manager"]] as const) {
    const e = await call("POST", "/employees", "owner", {
      firstName: who === "tess" ? "Tess" : "Max", lastName: who === "tess" ? "Taxpayer" : "Manager", email: email(who),
      password: "password123", role, payRateCents: 2000, startDate: "2030-03-04", status: who === "tess" ? "onboarding" : "active",
    });
    ID[who] = e.body.id;
    T[who] = (await call("POST", "/auth/login", undefined, { email: email(who), password: "password123" })).body.token;
  }
  await call("PUT", "/payroll/settings", "owner", { legalName: "Tax Co LLC", ein: "123456789", address: "1 Main St, Austin, TX 78701" });
});

beforeEach(async () => {
  await flushNotifications();
  pushes = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("tax forms", () => {
  it("onboarding form tasks finish when the form is submitted", async () => {
    const tpl = await call("POST", "/onboarding/templates", "owner", {
      name: "Paperwork",
      tasks: [
        { title: "W-4", assignee: "employee", action: "form", formType: "w4" },
        { title: "I-9 Section 1", assignee: "employee", action: "form", formType: "i9" },
        { title: "Direct deposit", assignee: "employee", action: "form", formType: "direct_deposit" },
        { title: "I-9 Section 2", assignee: "admin", dueInDays: 3, action: "form", formType: "i9_section2" },
      ],
    });
    expect(tpl.status).toBe(200);
    expect((await call("POST", "/onboarding/templates", "owner", { name: "x", tasks: [{ title: "bad", assignee: "employee", action: "form", formType: "i9_section2" }] })).status).toBe(400);
    await call("POST", "/onboarding/assign", "owner", { employeeId: ID.tess, templateId: tpl.body.id });
    const tasks = (await call("GET", "/onboarding/tasks", "tess")).body as any[];
    const w4Task = tasks.find((t) => t.formType === "w4");
    expect((await call("POST", `/onboarding/tasks/${w4Task.id}/complete`, "tess")).body.error).toMatch(/Fill out and sign/);

    expect((await call("POST", "/tax-forms/w4", "tess", { ...W4, ssn: "000-12-3456" })).status).toBe(400);
    const w4 = await call("POST", "/tax-forms/w4", "tess", W4);
    expect(w4.status).toBe(200);
    expect(w4.body.summary).toBe("SSN ***-**-6789 · married jointly");
    await call("POST", "/tax-forms/i9", "tess", I9);
    expect((await call("POST", "/tax-forms/direct-deposit", "tess", { ...DD, accountNumberConfirm: "999" })).status).toBe(400);
    await call("POST", "/tax-forms/direct-deposit", "tess", DD);

    const after = (await call("GET", "/onboarding/tasks", "tess")).body as any[];
    expect(after.filter((t) => t.assignee === "employee").every((t) => t.completedAt)).toBe(true);
    await flushNotifications();
    expect(pushes.map((p) => p.title)).toEqual(
      expect.arrayContaining(["Tess Taxpayer submitted a W-4", "Tess Taxpayer completed I-9 Section 1", "Tess Taxpayer submitted a direct deposit form"]),
    );
  });

  it("stores answers encrypted and never lists full numbers", async () => {
    const [row] = await db.select().from(taxForms).where(eq(taxForms.employeeId, ID.tess));
    expect(row.data).toMatch(/^v1\./);
    expect(row.data).not.toContain("123-45-6789");
    const pending = (await call("GET", "/tax-forms/pending", "owner")).body as any[];
    const dd = pending.find((f) => f.type === "direct_deposit");
    expect(dd.summary).toBe("Chase checking ••••6789");
    expect(JSON.stringify(pending)).not.toContain("000123456789");
  });

  it("only the employee and admins can open forms, and every view is logged", async () => {
    const w4 = ((await call("GET", "/tax-forms/mine", "tess")).body as any[]).find((f) => f.type === "w4");
    expect((await call("GET", `/tax-forms/${w4.id}`, "mgr")).status).toBe(404);
    expect((await call("GET", "/tax-forms/pending", "mgr")).status).toBe(403);
    expect((await call("GET", `/tax-forms/${w4.id}`, "tess")).body.data.ssn).toBe("123-45-6789");
    const asAdmin = await call("GET", `/tax-forms/${w4.id}`, "owner");
    expect(asAdmin.body.accessLog.map((l: any) => l.by)).toEqual(["Oscar Owner", "Tess Taxpayer"]);

    const pdf = await call("GET", `/tax-forms/${w4.id}/pdf`, "owner");
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.raw.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.headers["content-disposition"]).toContain("W-4-Taxpayer-Tess");
  });

  it("updating a W-4 supersedes the old one and asks admins to re-enter it", async () => {
    const prefill = await call("GET", "/tax-forms/prefill/w4", "tess");
    expect(prefill.body.city).toBe("Austin");
    expect(prefill.body.ssn).toBeUndefined();
    const updated = await call("POST", "/tax-forms/w4", "tess", { ...W4, filingStatus: "single", childrenAmount: 0 });
    await flushNotifications();
    expect(pushes.map((p) => p.title)).toContain("Tess Taxpayer updated their W-4");
    const mine = (await call("GET", "/tax-forms/mine", "tess")).body as any[];
    expect(mine.filter((f) => f.type === "w4")).toHaveLength(2);
    expect(mine.filter((f) => f.type === "w4" && !f.supersededAt).map((f) => f.id)).toEqual([updated.body.id]);

    await call("POST", `/tax-forms/${updated.body.id}/processed`, "owner");
    const pending = (await call("GET", "/tax-forms/pending", "owner")).body as any[];
    expect(pending.some((f) => f.type === "w4")).toBe(false);
  });

  it("an admin completes I-9 Section 2; after that the employee can't resubmit", async () => {
    const i9 = ((await call("GET", "/tax-forms/pending", "owner")).body as any[]).find((f) => f.type === "i9");
    const s2 = { firstDayOfEmployment: "2030-03-04", employerTitle: "Owner", signedName: "Oscar Owner" };
    expect((await call("POST", `/tax-forms/${i9.id}/i9-section-2`, "owner", s2)).status).toBe(400); // no documents
    const done = await call("POST", `/tax-forms/${i9.id}/i9-section-2`, "owner", {
      ...s2, listA: [{ title: "U.S. Passport", issuingAuthority: "U.S. Department of State", number: "X1234567", expires: "2034-05-01" }],
    });
    expect(done.body.status).toBe("completed");
    expect((await call("POST", "/tax-forms/i9", "tess", I9)).status).toBe(409);
    const pdf = await call("GET", `/tax-forms/${i9.id}/pdf`, "tess");
    expect(pdf.raw.subarray(0, 5).toString()).toBe("%PDF-");

    // The admin's Section 2 task finished, so the whole checklist is done.
    expect((await call("GET", `/employees/${ID.tess}`, "owner")).body.status).toBe("active");
  });

  it("can be switched off when a payroll provider collects the forms", async () => {
    await call("PUT", "/payroll/settings", "owner", { taxFormsInCrewdesk: false });
    expect((await call("GET", "/tax-forms/settings", "tess")).body.enabled).toBe(false);
    expect((await call("POST", "/tax-forms/direct-deposit", "tess", DD)).status).toBe(400);
    await call("PUT", "/payroll/settings", "owner", { taxFormsInCrewdesk: true });
  });
});

describe("manual payroll export", () => {
  it("splits time off across pay periods by day", () => {
    const req = { startDate: "2030-03-07", endDate: "2030-03-10", hours: 32 }; // Thu–Sun
    expect(ptoHoursInPeriod(req, { periodStart: "2030-03-04", periodEnd: "2030-03-08" })).toBe(16);
    expect(ptoHoursInPeriod(req, { periodStart: "2030-03-09", periodEnd: "2030-03-15" })).toBe(16);
    expect(ptoHoursInPeriod(req, { periodStart: "2030-03-11", periodEnd: "2030-03-15" })).toBe(0);
  });

  it("exports worked hours, time off and unapproved counts; can export approved time only", async () => {
    // Two 8-hour days, one approved.
    for (const day of ["2030-03-04", "2030-03-05"]) {
      await call("POST", "/time/clock-in", "tess", {});
      await call("POST", "/time/clock-out", "tess", {});
      // The entry just made (today), not one already moved into 2030.
      const entry = ((await call("GET", "/time/entries", "tess")).body as any[]).find((e) => !e.clockIn.startsWith("2030"));
      await call("PATCH", `/time/entries/${entry.id}`, "owner", { clockIn: `${day}T14:00:00.000Z`, clockOut: `${day}T22:00:00.000Z` });
    }
    const entries = (await call("GET", `/time/entries?employeeId=${ID.tess}&from=2030-03-04&to=2030-03-06`, "owner")).body as any[];
    await call("POST", "/time/entries/approve", "owner", { ids: [entries[0].id] });

    const policy = await call("POST", "/pto/policies", "owner", { name: "PTO" });
    await call("POST", "/pto/adjustments", "owner", { employeeId: ID.tess, policyId: policy.body.id, hours: 40 });
    const pto = await call("POST", "/pto/requests", "tess", { policyId: policy.body.id, startDate: "2030-03-07", endDate: "2030-03-08", hours: 16 });
    await call("POST", `/pto/requests/${pto.body.id}/decide`, "owner", { status: "approved" });

    const q = "periodStart=2030-03-04&periodEnd=2030-03-08";
    const all = ((await call("GET", `/payroll/preview?${q}`, "owner")).body as any[]).find((l) => l.employeeId === ID.tess);
    expect(all).toMatchObject({ totalHours: 16, ptoHours: 16, unapprovedEntries: 1, estimatedGrossCents: 64000 });
    const approved = ((await call("GET", `/payroll/preview?${q}&approvedOnly=true`, "owner")).body as any[]).find((l) => l.employeeId === ID.tess);
    expect(approved).toMatchObject({ totalHours: 8, ptoHours: 16, estimatedGrossCents: 48000 });

    const csv = await call("GET", `/payroll/export.csv?${q}`, "owner");
    expect(csv.body.split("\n")[0]).toContain("Time Off Hours");
    expect(csv.body).toContain("Tess,Taxpayer");
    expect(csv.body).toContain(",16.00,16.00,640.00");
    expect((await call("GET", "/payroll/preview?periodStart=2030-03-08&periodEnd=2030-03-04", "owner")).status).toBe(400);
  });
});
