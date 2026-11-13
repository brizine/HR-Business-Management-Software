import { describe, expect, it } from "vitest";
import { employeeContactSchema, formatPhone, formatPhoneTyping, normalizePhone, toE164 } from "../src";

describe("phone numbers", () => {
  it("saves US numbers as (555) 555-5555, however they were typed", () => {
    for (const typed of ["5125550100", "512-555-0100", "512.555.0100", "(512)5550100", "+1 512 555 0100", "1-512-555-0100"]) {
      expect(normalizePhone(typed)).toBe("(512) 555-0100");
    }
  });

  it("leaves international numbers, short numbers and extensions as typed", () => {
    expect(normalizePhone(" +44 20 7946 0958 ")).toBe("+44 20 7946 0958");
    expect(normalizePhone("555-1234")).toBe("555-1234");
    expect(normalizePhone("512-555-0100 ext 4")).toBe("512-555-0100 ext 4");
    expect(normalizePhone(null)).toBeNull();
    expect(formatPhone(null)).toBe("");
  });

  it("formats as you type", () => {
    expect(["5", "51", "512", "5125", "51255", "512555", "5125550", "5125550100"].map(formatPhoneTyping)).toEqual([
      "(5", "(51", "(512", "(512) 5", "(512) 55", "(512) 555", "(512) 555-0", "(512) 555-0100",
    ]);
    expect(formatPhoneTyping("(512) 555-01009")).toBe("(512) 555-01009"); // too long: left alone
    expect(formatPhoneTyping("+1 512")).toBe("(512");
    expect(formatPhoneTyping("+44 20")).toBe("+44 20");
    expect(formatPhoneTyping("")).toBe("");
  });

  it("is applied when saving, and still works for texting", () => {
    const parsed = employeeContactSchema.parse({ phone: "512 555 0100", emergencyPhone: "" });
    expect(parsed.phone).toBe("(512) 555-0100");
    expect(parsed.emergencyPhone).toBeNull();
    expect(toE164(parsed.phone)).toBe("+15125550100");
  });
});
