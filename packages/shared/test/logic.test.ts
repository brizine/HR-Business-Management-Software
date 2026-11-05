import { describe, expect, it } from "vitest";
import { computeDue, summarizeHours, hasRole } from "../src";

describe("computeDue", () => {
  const today = new Date("2026-06-01T12:00:00Z");

  it("is ok when well within all intervals", () => {
    const r = computeDue(
      { intervalMiles: 5000, intervalDays: 180, lastServiceOdometer: 10000, lastServiceDate: "2026-05-01" },
      { odometer: 11000, engineHours: 0 },
      today,
    );
    expect(r.status).toBe("ok");
    expect(r.nextDueOdometer).toBe(15000);
    expect(r.nextDueDate).toBe("2026-10-28");
  });

  it("is due soon within 10% of the mileage interval", () => {
    const r = computeDue({ intervalMiles: 5000, lastServiceOdometer: 10000 }, { odometer: 14600, engineHours: 0 }, today);
    expect(r.status).toBe("due_soon");
  });

  it("whichever interval is hit first makes it overdue", () => {
    const r = computeDue(
      { intervalMiles: 5000, intervalDays: 30, lastServiceOdometer: 10000, lastServiceDate: "2026-04-01" },
      { odometer: 10500, engineHours: 0 },
      today,
    );
    expect(r.status).toBe("overdue");
    expect(r.reasons[0]).toMatch(/days/);
  });

  it("supports engine-hour intervals", () => {
    const r = computeDue({ intervalHours: 250, lastServiceHours: 1000 }, { odometer: 0, engineHours: 1260 }, today);
    expect(r.status).toBe("overdue");
    expect(r.nextDueHours).toBe(1250);
  });
});

describe("summarizeHours", () => {
  it("puts hours over 40 per week into overtime", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      clockIn: `2026-06-0${i + 1}T08:00:00Z`,
      clockOut: `2026-06-0${i + 1}T18:00:00Z`,
    }));
    expect(summarizeHours(entries)).toEqual({ totalHours: 50, regularHours: 40, overtimeHours: 10 });
  });
});

describe("hasRole", () => {
  it("ranks roles", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("employee", "manager")).toBe(false);
  });
});

import { toE164, webPathFor } from "../src";

describe("toE164", () => {
  it("normalizes common formats", () => {
    expect(toE164("(512) 555-0142")).toBe("+15125550142");
    expect(toE164("1-512-555-0142")).toBe("+15125550142");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0142")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});

describe("webPathFor", () => {
  it("maps links to web pages", () => {
    expect(webPathFor({ screen: "asset", id: "a1" })).toBe("/fleet/a1");
    expect(webPathFor(null)).toBeNull();
  });
});

import { availabilityConflicts, describeRule, shiftSegments } from "../src";

describe("availability", () => {
  const tuesdayAllDay = { weekday: 2 };
  const fridayMorning = { weekday: 5, endTime: "14:00" };

  it("describes rules", () => {
    expect(describeRule(tuesdayAllDay)).toBe("All day");
    expect(describeRule(fridayMorning)).toBe("Before 2pm");
    expect(describeRule({ weekday: 1, startTime: "17:30" })).toBe("After 5:30pm");
  });

  it("finds overlaps, including overnight shifts", () => {
    const fri = (from: number, to: number) => [{ weekday: 5, from, to }];
    expect(availabilityConflicts([fridayMorning], fri(13 * 60, 18 * 60))).toHaveLength(1);
    expect(availabilityConflicts([fridayMorning], fri(14 * 60, 18 * 60))).toHaveLength(0); // starts right when free
    // Monday 10pm → Tuesday 6am runs into Tuesday.
    const segs = shiftSegments({ weekday: 1, minutes: 22 * 60, date: "2030-01-07" }, { weekday: 2, minutes: 6 * 60, date: "2030-01-08" });
    expect(segs).toEqual([{ weekday: 1, from: 1320, to: 1440 }, { weekday: 2, from: 0, to: 360 }]);
    expect(availabilityConflicts([tuesdayAllDay], segs)).toHaveLength(1);
  });
});

import { codeFromScan } from "../src";

describe("codeFromScan", () => {
  it("reads label URLs, app links and bare codes", () => {
    expect(codeFromScan("https://app.example.com/q/ET2W42AUDZ")).toBe("ET2W42AUDZ");
    expect(codeFromScan("https://app.example.com/q/ET2W42AUDZ/?utm=x")).toBe("ET2W42AUDZ");
    expect(codeFromScan("crewdesk://q/ET2W42AUDZ")).toBe("ET2W42AUDZ");
    expect(codeFromScan(" et2w42audz ")).toBe("et2w42audz");
  });

  it("ignores unrelated QR codes", () => {
    expect(codeFromScan("https://example.com/menu")).toBeNull();
    expect(codeFromScan("WIFI:S:guest;T:WPA;P:hunter2;;")).toBeNull();
  });
});

import { directDepositSchema, i9Section1Schema, isValidRoutingNumber, maskAccount, maskSsn, ssnSchema, w4Schema } from "../src";

describe("tax form validation", () => {
  it("normalizes SSNs and rejects ones the SSA never issues", () => {
    expect(ssnSchema.parse("123456789")).toBe("123-45-6789");
    for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000", "12-345-6789"]) {
      expect(ssnSchema.safeParse(bad).success).toBe(false);
    }
    expect(maskSsn("123-45-6789")).toBe("***-**-6789");
  });

  it("checks routing number checksums", () => {
    expect(isValidRoutingNumber("021000021")).toBe(true); // JPMorgan Chase, NY
    expect(isValidRoutingNumber("011000015")).toBe(true); // Federal Reserve Bank of Boston
    expect(isValidRoutingNumber("021000022")).toBe(false);
    expect(isValidRoutingNumber("12345")).toBe(false);
    expect(maskAccount("000123456789")).toBe("••••6789");
  });

  it("requires matching account numbers", () => {
    const base = { bankName: "Chase", routingNumber: "021000021", accountNumber: "123456789", accountType: "checking", signedName: "Pat Doe" };
    expect(directDepositSchema.safeParse({ ...base, accountNumberConfirm: "123456789" }).success).toBe(true);
    expect(directDepositSchema.safeParse({ ...base, accountNumberConfirm: "123456780" }).success).toBe(false);
  });

  it("W-4: exemption excludes extra withholding", () => {
    const base = { firstName: "Pat", lastName: "Doe", address: "1 Main St", city: "Austin", state: "TX", zip: "78701", ssn: "123-45-6789", filingStatus: "single", signedName: "Pat Doe" };
    expect(w4Schema.safeParse(base).success).toBe(true);
    expect(w4Schema.safeParse({ ...base, exempt: true, extraWithholding: 20 }).success).toBe(false);
  });

  it("I-9: status-specific numbers are required", () => {
    const base = { lastName: "Doe", firstName: "Pat", address: "1 Main St", city: "Austin", state: "TX", zip: "78701", dateOfBirth: "1990-04-01", signedName: "Pat Doe" };
    expect(i9Section1Schema.safeParse({ ...base, citizenship: "citizen" }).success).toBe(true);
    expect(i9Section1Schema.safeParse({ ...base, citizenship: "permanent_resident" }).success).toBe(false);
    expect(i9Section1Schema.safeParse({ ...base, citizenship: "permanent_resident", uscisNumber: "A123456789" }).success).toBe(true);
    expect(i9Section1Schema.safeParse({ ...base, citizenship: "authorized_alien", i94Number: "12345678901" }).success).toBe(false);
    expect(i9Section1Schema.safeParse({ ...base, citizenship: "authorized_alien", i94Number: "12345678901", workAuthExpires: "2028-01-01" }).success).toBe(true);
  });
});

import { distanceMeters, formatDistance, nearestSite, parseCoordinates } from "../src";

describe("geofencing", () => {
  const yard = { id: "yard", name: "North yard", lat: 30.2672, lng: -97.7431, radiusMeters: 150 };
  const hoa = { id: "hoa", name: "Riverside HOA", lat: 30.25, lng: -97.75, radiusMeters: 300 };

  it("measures distance", () => {
    // Austin → Dallas is about 293 km as the crow flies.
    expect(distanceMeters({ lat: 30.2672, lng: -97.7431 }, { lat: 32.7767, lng: -96.797 }) / 1000).toBeCloseTo(293, -1);
    expect(formatDistance(120.4)).toBe("120 m");
    expect(formatDistance(2345)).toBe("2.3 km");
  });

  it("finds the site you're at, forgiving reported GPS inaccuracy (capped)", () => {
    const at = nearestSite({ lat: 30.2675, lng: -97.7433 }, [yard, hoa])!;
    expect(at.site.id).toBe("yard");
    expect(at.onSite).toBe(true);
    // ~200 m north of the yard: outside its 150 m radius…
    const edge = { lat: 30.2690, lng: -97.7431 };
    expect(nearestSite(edge, [yard])!.onSite).toBe(false);
    // …but inside once a 60 m GPS uncertainty is allowed for.
    expect(nearestSite({ ...edge, accuracy: 60 }, [yard])!.onSite).toBe(true);
    // A terrible fix (2 km) doesn't put you on site from far away.
    expect(nearestSite({ lat: 30.29, lng: -97.7431, accuracy: 2000 }, [yard])!.onSite).toBe(false);
    expect(nearestSite({ lat: 0, lng: 0 }, [])).toBeNull();
  });

  it("reads coordinates from map links", () => {
    expect(parseCoordinates("https://www.google.com/maps/place/Yard/@30.2672,-97.7431,17z")).toEqual({ lat: 30.2672, lng: -97.7431 });
    expect(parseCoordinates("https://maps.apple.com/?ll=30.2672,-97.7431&q=Yard")).toEqual({ lat: 30.2672, lng: -97.7431 });
    expect(parseCoordinates("30.2672, -97.7431")).toEqual({ lat: 30.2672, lng: -97.7431 });
    expect(parseCoordinates("https://www.google.com/maps/place/x/data=!3d30.2672!4d-97.7431")).toEqual({ lat: 30.2672, lng: -97.7431 });
    expect(parseCoordinates("123 Main St")).toBeNull();
  });
});

import { SPRAY_MIX_TEMPLATE, computeMix, formatAmount } from "../src";

describe("spray tank mix", () => {
  const mix = (name: string) => SPRAY_MIX_TEMPLATE.find((m) => m.name === name)!;
  const truck = mix("Truck 2gal/1000ft");
  const z = mix("ZSpray(Green Tips)");
  const row = (sheet: typeof truck, tank: number, name: string) => computeMix(sheet, tank).rows.find((r) => r.product.name === name)!;

  it("matches the spreadsheet's Truck Mix (75 gal)", () => {
    // Spreadsheet: C = rate/43.56, F = C/2*75
    expect(row(truck, 75, "Aquacap").ratePer1000).toBeCloseTo(47.9 / 43.56, 10);
    expect(row(truck, 75, "Aquacap").needed).toBeCloseTo((47.9 / 43.56 / 2) * 75, 10);
    expect(row(truck, 75, "46-0-0").needed).toBeCloseTo(81.784, 3);
    expect(computeMix(truck, 75).acres).toBeCloseTo(0.8609, 4);
    expect(computeMix(truck, 75).gallonsPer1000).toBeCloseTo(2, 10);
  });

  it("matches the spreadsheet's Z spray Mix (12 gal)", () => {
    // Spreadsheet: F = rate/11.1*12
    expect(row(z, 12, "Specticle Flo").needed).toBeCloseTo((6 / 11.1) * 12, 10);
    expect(row(z, 12, "Acid Blue 9 Dye").needed).toBeCloseTo(86.486, 3);
    // The spreadsheet's F36 used the truck formula for 90/10 Surfactant (3.86 oz); the consistent formula gives 30.27 oz.
    expect(row(z, 12, "90/10 Surfactant").needed).toBeCloseTo(30.27, 2);
  });

  it("matches every value Excel saved in the original file (except the one known formula slip)", () => {
    // Column F as cached by Excel in Spray_Tank_Fill_Spreadsheet.xlsx (tank 75 gal / 12 gal).
    const truckExcel = [12.91322314, 4.304407713, 41.2362259, 16.35674931, 20.66115702, 41.32231405, 24.1046832, 31.85261708,
      55.09641873, 7.498278237, 0.2152203857, 4.218319559, 3.185261708, 0.2152203857, 81.78374656, 5.165289256];
    const zExcel = [16.21621622, 6.486486486, 12.97297297, 20.54054054, 10.81081081, 40, 3.856749311, 13.2972973,
      69.18918919, 86.48648649, 0.572972973, 5.297297297, 4, 0.3567567568];
    computeMix(truck, 75).rows.forEach((r, i) => expect(r.needed).toBeCloseTo(truckExcel[i], 6));
    computeMix(z, 12).rows.forEach((r, i) => {
      if (r.product.name === "90/10 Surfactant") expect(zExcel[i]).toBeCloseTo(3.857, 3); // spreadsheet's F36
      else expect(r.needed).toBeCloseTo(zExcel[i], 6);
    });
  });

  it("has the truck at 1.5 gal/1000 and the backpack at 1 gal/1000 with the Truck Mix rates", () => {
    const truck15 = mix("Truck 1.5gal/1000ft");
    const backpack = mix("Backpack 1gal/1000ft");
    expect(computeMix(truck15, 75).gallonsPer1000).toBeCloseTo(1.5, 10);
    expect(computeMix(backpack, 4).gallonsPer1000).toBeCloseTo(1, 10);
    expect(truck15.products).toEqual(truck.products);
    expect(backpack.products).toEqual(truck.products);
    // 1 gal/1000: a 4-gal backpack covers 4,000 ft², so it gets 4 × the per-1,000 rate.
    expect(row(backpack, 4, "Aquacap").needed).toBeCloseTo((47.9 / 43.56) * 4, 10);
    expect(row(truck15, 75, "Aquacap").needed).toBeCloseTo((47.9 / 43.56 / 1.5) * 75, 10);
    expect(computeMix(backpack, 4).squareFeet).toBeCloseTo(4000, 6);
  });

  it("handles empty or bad tank sizes without blowing up", () => {
    expect(computeMix(truck, 0).rows[0].needed).toBe(0);
    expect(computeMix(truck, NaN).rows[0].needed).toBe(0);
    expect(formatAmount(0.2525)).toBe("0.253");
    expect(formatAmount(7.4)).toBe("7.40");
    expect(formatAmount(81.783)).toBe("81.8");
  });
});

import { ageOn } from "../src";

describe("ageOn", () => {
  it("counts whole years, turning a year older on the birthday", () => {
    expect(ageOn("1990-04-23", new Date(2026, 3, 22))).toBe(35);
    expect(ageOn("1990-04-23", new Date(2026, 3, 23))).toBe(36);
    expect(ageOn("2000-12-31", new Date(2026, 0, 1))).toBe(25);
  });
});

import { totalsByUnit } from "../src";

describe("totalsByUnit", () => {
  it("adds amounts per measurement, never across measurements", () => {
    const row = (unit: string, needed: number) => ({ product: { unit }, needed });
    expect(totalsByUnit([row("ounces liquid", 41.2), row("ounces dry", 12.9), row("ounces liquid", 24.1), row("pounds dry", 81.8)])).toEqual([
      { unit: "ounces liquid", amount: 41.2 + 24.1 },
      { unit: "ounces dry", amount: 12.9 },
      { unit: "pounds dry", amount: 81.8 },
    ]);
    expect(totalsByUnit([])).toEqual([]);
  });
});

import { lastEndedPeriod, periodContaining, upcomingPeriods } from "../src";

describe("pay periods", () => {
  const weekly = { frequency: "weekly" as const, anchorDate: "2026-01-05", paydayOffsetDays: 5 };
  it("counts weekly and bi-weekly periods from the anchor, before and after it", () => {
    expect(periodContaining("2026-11-04", weekly)).toEqual({ start: "2026-11-02", end: "2026-11-08", payday: "2026-11-13" });
    expect(periodContaining("2025-12-31", weekly)).toEqual({ start: "2025-12-29", end: "2026-01-04", payday: "2026-01-09" });
    const biweekly = { ...weekly, frequency: "biweekly" as const };
    expect(periodContaining("2026-01-18", biweekly)).toMatchObject({ start: "2026-01-05", end: "2026-01-18" });
    expect(periodContaining("2026-01-19", biweekly)).toMatchObject({ start: "2026-01-19", end: "2026-02-01" });
  });
  it("splits semi-monthly at the 15th and uses calendar months", () => {
    const semi = { frequency: "semimonthly" as const, paydayOffsetDays: 0 };
    expect(periodContaining("2026-02-15", semi)).toMatchObject({ start: "2026-02-01", end: "2026-02-15" });
    expect(periodContaining("2026-02-16", semi)).toMatchObject({ start: "2026-02-16", end: "2026-02-28" });
    expect(periodContaining("2028-02-20", semi)).toMatchObject({ end: "2028-02-29" });
    expect(periodContaining("2026-12-31", { frequency: "monthly", paydayOffsetDays: 3 })).toEqual({ start: "2026-12-01", end: "2026-12-31", payday: "2027-01-03" });
  });
  it("finds the period that just ended, and lists upcoming ones back to back", () => {
    // Sunday Nov 8 is the last day; on Monday Nov 9 that period has ended.
    expect(lastEndedPeriod("2026-11-09", weekly)).toMatchObject({ start: "2026-11-02", end: "2026-11-08" });
    // Mid-week, the last ended period is still the previous week.
    expect(lastEndedPeriod("2026-11-11", weekly)).toMatchObject({ start: "2026-11-02", end: "2026-11-08" });
    expect(lastEndedPeriod("2026-11-16", { frequency: "semimonthly", paydayOffsetDays: 0 })).toMatchObject({ start: "2026-11-01", end: "2026-11-15" });
    const next = upcomingPeriods("2026-11-04", weekly, 3);
    expect(next.map((p) => p.start)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });
});

import { describePto, effectivePto, lastGrantDate, yearsOfService } from "../src";

describe("time-off accrual rules", () => {
  const policy = {
    accrualRate: 1 / 30,
    annualGrantHours: 40,
    grantSchedule: "anniversary",
    tiers: [
      { afterYears: 5, accrualRate: 1 / 20, grantHours: 80 },
      { afterYears: 1, accrualRate: 1 / 25, grantHours: null },
    ],
    maxBalanceHours: 200,
  };
  it("counts whole years of service from the hire date", () => {
    expect(yearsOfService("2021-11-01", "2026-10-31")).toBe(4);
    expect(yearsOfService("2021-11-01", "2026-11-01")).toBe(5);
    expect(yearsOfService("2024-02-29", "2025-02-28")).toBe(1);
    expect(yearsOfService(null, "2026-11-01")).toBe(0);
    expect(yearsOfService("2027-01-01", "2026-11-01")).toBe(0);
  });
  it("applies the highest step reached, keeping amounts a step leaves blank", () => {
    expect(effectivePto(policy, 0)).toEqual({ accrualRate: 1 / 30, grantHours: 40, tier: null });
    expect(effectivePto(policy, 3)).toEqual({ accrualRate: 1 / 25, grantHours: 40, tier: 1 });
    expect(effectivePto(policy, 5)).toEqual({ accrualRate: 1 / 20, grantHours: 80, tier: 5 });
  });
  it("finds the latest award date for each schedule", () => {
    expect(lastGrantDate(policy, "2021-11-01", "2026-11-01")).toBe("2026-11-01");
    expect(lastGrantDate(policy, "2021-11-02", "2026-11-01")).toBe("2025-11-02");
    expect(lastGrantDate(policy, "2026-03-01", "2026-11-01")).toBeNull(); // before the first anniversary
    expect(lastGrantDate(policy, null, "2026-11-01")).toBeNull();
    expect(lastGrantDate({ ...policy, grantSchedule: "anniversary" }, "2024-02-29", "2027-03-01")).toBe("2027-02-28");
    const jan1 = { ...policy, grantSchedule: "yearly_date", grantDate: "01-01" };
    expect(lastGrantDate(jan1, null, "2026-11-01")).toBe("2026-01-01");
    const monthly = { ...policy, grantSchedule: "monthly", grantDayOfMonth: 15 };
    expect(lastGrantDate(monthly, null, "2026-11-01")).toBe("2026-10-15");
    expect(lastGrantDate(monthly, null, "2026-01-10")).toBe("2025-12-15");
    expect(lastGrantDate({ ...policy, grantSchedule: "none" }, "2021-11-01", "2026-11-01")).toBeNull();
  });
  it("describes a policy in plain English", () => {
    expect(describePto(policy)).toBe("Earns 1h per 30h worked · 40h on each hire anniversary · after 1 year: 1h per 25h worked · after 5 years: 1h per 20h worked, 80h awards · cap 200h");
  });
});

import { carryoverForfeit, lastResetDate } from "../src";

describe("time-off carryover", () => {
  const p = { accrualRate: 0, annualGrantHours: 0, grantSchedule: "none", carryoverLimitHours: 40, carryoverReset: "yearly_date", carryoverDate: "01-01" };
  it("finds the latest reset and how much to remove", () => {
    expect(lastResetDate(p, null, "2026-11-01")).toBe("2026-01-01");
    expect(lastResetDate({ ...p, carryoverReset: "anniversary" }, "2021-11-02", "2026-11-01")).toBe("2025-11-02");
    expect(lastResetDate({ ...p, carryoverLimitHours: null }, null, "2026-11-01")).toBeNull();
    expect(carryoverForfeit(100, 0, 40)).toBe(60);
    expect(carryoverForfeit(100, 10, 40)).toBe(50); // hours in pending requests are kept
    expect(carryoverForfeit(30, 0, 40)).toBe(0);
    expect(carryoverForfeit(25, 0, 0)).toBe(25); // use it or lose it
  });
  it("describes the limit", () => {
    expect(describePto(p)).toBe("No automatic accrual · carry over up to 40h (resets every Jan 1)");
    expect(describePto({ ...p, carryoverLimitHours: 0, carryoverReset: "anniversary" })).toBe("No automatic accrual · use it or lose it (resets each hire anniversary)");
  });
});

import { DEFAULT_HOLIDAY_RULES, HOLIDAY_PRESETS, describeHolidayRule, holidayDate, holidayHoursFor, holidaysBetween, observedDate } from "../src/holidays";

describe("paid holidays", () => {
  const preset = (k: string) => HOLIDAY_PRESETS.find((p) => p.key === k)!.rule;
  it("works out each year's date from the rule", () => {
    expect(holidayDate(preset("thanksgiving"), 2026)).toBe("2026-11-26");
    expect(holidayDate(preset("black_friday"), 2026)).toBe("2026-11-27");
    expect(holidayDate(preset("memorial"), 2026)).toBe("2026-05-25");
    expect(holidayDate(preset("labor"), 2027)).toBe("2027-09-06");
    expect(holidayDate(preset("mlk"), 2027)).toBe("2027-01-18");
    expect(holidayDate({ kind: "once", date: "2026-12-26" }, 2026)).toBe("2026-12-26");
    expect(holidayDate({ kind: "once", date: "2026-12-26" }, 2027)).toBeNull();
    expect(holidayDate({ kind: "fixed", month: 2, day: 30 }, 2027)).toBe("2027-02-28");
  });
  it("moves weekend holidays to Friday or Monday when observed", () => {
    expect(observedDate("2026-07-04", "nearest")).toBe("2026-07-03"); // Saturday → Friday
    expect(observedDate("2027-12-25", "nearest")).toBe("2027-12-24"); // Saturday
    expect(observedDate("2028-12-25", "nearest")).toBe("2028-12-25"); // Monday
    expect(observedDate("2022-12-25", "nearest")).toBe("2022-12-26"); // Sunday → Monday
    expect(observedDate("2026-07-04", "none")).toBe("2026-07-04");
  });
  it("finds holidays in a range, including one observed in the year before", () => {
    const list = [{ name: "New Year", rule: preset("new_year"), observe: "nearest" as const }, { name: "July 4", rule: preset("independence"), observe: "nearest" as const }];
    // Jan 1, 2028 is a Saturday: observed Friday Dec 31, 2027.
    expect(holidaysBetween(list, "2027-12-27", "2028-01-02").map((o) => [o.holiday.name, o.date, o.observed])).toEqual([["New Year", "2028-01-01", "2027-12-31"]]);
    expect(holidaysBetween(list, "2026-07-01", "2026-07-07").map((o) => o.observed)).toEqual(["2026-07-03"]);
    expect(holidaysBetween([{ ...list[0], active: false }], "2027-12-27", "2028-01-02")).toEqual([]);
  });
  it("pays eligible people: employment type, waiting period, part-time share", () => {
    const rules = { ...DEFAULT_HOLIDAY_RULES, eligibleTypes: ["full_time", "part_time"] as never, waitingDays: 30, partTimeShare: 0.5 };
    expect(holidayHoursFor({ employmentType: "full_time", hireDate: "2026-01-01" }, rules, 8, "2026-07-03")).toBe(8);
    expect(holidayHoursFor({ employmentType: "part_time", hireDate: "2026-01-01" }, rules, 8, "2026-07-03")).toBe(4);
    expect(holidayHoursFor({ employmentType: "seasonal", hireDate: "2026-01-01" }, rules, 8, "2026-07-03")).toBe(0);
    expect(holidayHoursFor({ employmentType: "full_time", hireDate: "2026-06-20" }, rules, 8, "2026-07-03")).toBe(0); // still waiting
    expect(holidayHoursFor({ employmentType: "full_time", hireDate: null }, rules, 8, "2026-07-03")).toBe(8);
  });
  it("describes rules", () => {
    expect(describeHolidayRule(preset("thanksgiving"))).toBe("4th Thursday of November");
    expect(describeHolidayRule(preset("black_friday"))).toBe("Day after the 4th Thursday of November");
    expect(describeHolidayRule(preset("memorial"))).toBe("Last Monday of May");
    expect(describeHolidayRule(preset("independence"))).toBe("July 4, every year");
  });
});

import { checkWorkAround } from "../src/holidays";

describe("holiday rule: work the scheduled day before and after", () => {
  // Thanksgiving Thu 2026-11-26; scheduled Mon–Wed and Fri.
  const scheduledDays = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"];
  const base = { observed: "2026-11-26", scheduledDays, timeOff: [], today: "2026-12-15" };
  it("pays when both scheduled days were worked", () => {
    expect(checkWorkAround({ ...base, workedDays: new Set(["2026-11-25", "2026-11-27"]) })).toMatchObject({ met: true, before: "2026-11-25", after: "2026-11-27", missed: [] });
  });
  it("doesn't pay when a scheduled day was missed", () => {
    expect(checkWorkAround({ ...base, workedDays: new Set(["2026-11-25"]) })).toMatchObject({ met: false, missed: ["after"] });
    expect(checkWorkAround({ ...base, workedDays: new Set(["2026-11-24", "2026-11-27"]) })).toMatchObject({ met: false, missed: ["before"] });
  });
  it("counts approved time off as worked", () => {
    expect(checkWorkAround({ ...base, workedDays: new Set(["2026-11-25"]), timeOff: [{ startDate: "2026-11-27", endDate: "2026-11-30" }] }).met).toBe(true);
  });
  it("doesn't block people with nothing scheduled, and counts a day after that hasn't come yet", () => {
    expect(checkWorkAround({ ...base, scheduledDays: [], workedDays: new Set() }).met).toBe(true);
    expect(checkWorkAround({ ...base, workedDays: new Set(["2026-11-25"]), today: "2026-11-26" })).toMatchObject({ met: true, afterPending: true });
  });
});
