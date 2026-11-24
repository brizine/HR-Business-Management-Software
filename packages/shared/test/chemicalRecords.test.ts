import { describe, expect, it } from "vitest";
import { ODAFF_ITEMS, csvCell, dilutionPerGal, isPoBox, recordIssues, tankMixGallons } from "../src";

const complete = {
  companyName: "Co", companyAddress: "1 Main, Norman, OK 73069", applicatorName: "Tech", applicatorCertNo: "C-1", applicatorCertExpires: "2027-01-01",
  customerName: "Jane", customerAddress: "2 Oak, Norman, OK", siteAddress: "2 Oak, Norman, OK", appliedOn: "2026-04-15",
  startedAt: "2026-04-15T13:00:00Z", stoppedAt: "2026-04-15T13:20:00Z", site: "Turf", areaSqFt: 8000,
  products: [{ tradeName: "Herb", epaRegNo: "1-2", productType: "herbicide", amount: 1, targets: "Weeds", reiHours: 0, labelId: "l1", carrierGalPer1000: 2 }],
};

describe("ODAFF record checks", () => {
  it("lists the rule's 22 items in order", () => {
    expect(ODAFF_ITEMS.map((i) => i.n)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it("finds nothing missing on a complete record (an REI of 0 counts)", () => {
    expect(recordIssues(complete)).toEqual([]);
  });

  it("checks the certification against the application date", () => {
    expect(recordIssues({ ...complete, applicatorCertExpires: "2026-04-14" })).toEqual(["4: Tech's certification expired 2026-04-14"]);
    expect(recordIssues({ ...complete, applicatorCertExpires: "2026-04-15" })).toEqual([]);
  });

  it("skips pesticide checks for fertilizer and adjuvants", () => {
    const fert = { ...complete.products[0], tradeName: "Fert", productType: "fertilizer", epaRegNo: null, targets: null, reiHours: null, labelId: null };
    expect(recordIssues({ ...complete, products: [...complete.products, fert] })).toEqual([]);
  });

  it("spots PO Boxes", () => {
    expect(isPoBox("PO Box 12, Norman")).toBe(true);
    expect(isPoBox("P.O. Box 9")).toBe(true);
    expect(isPoBox("Post Office Box 3")).toBe(true);
    expect(isPoBox("12 Boxwood Ln")).toBe(false);
    expect(isPoBox("1 Pobox Rd")).toBe(false);
  });

  it("works out dilution and tank mix", () => {
    expect(dilutionPerGal(0.085, 2)).toBeCloseTo(0.0425, 9);
    expect(dilutionPerGal(3, null)).toBeNull();
    expect(tankMixGallons([{ carrierGalPer1000: 2 }, { carrierGalPer1000: null }], 8000)).toBe(16);
    expect(tankMixGallons([{ carrierGalPer1000: null }], 8000)).toBeNull();
  });

  it("keeps CSV cells safe in spreadsheets", () => {
    expect(csvCell('Say "hi", ok')).toBe('"Say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
  });
});
