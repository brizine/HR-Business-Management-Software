import { describe, expect, it } from "vitest";
import { TEXT_MAX, textInitials, textKeyword, textSegments, textSendSchema, textWords, webPathFor } from "../src";

describe("texting", () => {
  it("counts words and how many texts a message goes as", () => {
    expect(textWords("")).toBe(0);
    expect(textWords("  See you   Tuesday \n at 2 ")).toBe(5);
    expect(textSegments("a".repeat(160))).toMatchObject({ segments: 1, unicode: false });
    expect(textSegments("a".repeat(161))).toMatchObject({ segments: 2 });
    // An emoji makes the whole text count the short way (70 a text).
    expect(textSegments(`${"a".repeat(69)}🙂`)).toMatchObject({ segments: 2, unicode: true });
  });

  it("reads STOP and START the way carriers do", () => {
    expect(textKeyword(" stop. ")).toBe("stop");
    expect(textKeyword("Unsubscribe")).toBe("stop");
    expect(textKeyword("START")).toBe("start");
    expect(textKeyword("Please stop by Tuesday")).toBeNull();
  });

  it("makes the two letters for a conversation's badge", () => {
    expect(textInitials("John Example")).toBe("JE");
    expect(textInitials("Brookhaven Commons HOA")).toBe("BH");
    expect(textInitials("Cher")).toBe("C");
    expect(textInitials(null)).toBe("#");
    expect(textInitials("(405) 555-0100")).toBe("#");
  });

  it("a send needs a message, and takes any mix of people", () => {
    expect(textSendSchema.safeParse({ body: "  " }).success).toBe(false);
    expect(textSendSchema.safeParse({ body: "x".repeat(TEXT_MAX + 1) }).success).toBe(false);
    expect(textSendSchema.parse({ body: " Hi ", phones: ["405-555-0100"] })).toEqual({ body: "Hi", customerIds: [], employeeIds: [], groupIds: [], crewIds: [], phones: ["405-555-0100"] });
  });

  it("a text notification opens its conversation", () => {
    expect(webPathFor({ screen: "texts", threadId: "abc" })).toBe("/texts?thread=abc");
    expect(webPathFor({ screen: "texts" })).toBe("/texts");
  });
});

describe("texting hours", () => {
  // Wednesday Nov 25, 2026, 9:30 PM in Norman (03:30 UTC on the 26th).
  const night = new Date("2026-11-26T03:30:00Z"), noon = new Date("2026-11-25T18:00:00Z");
  const tz = "America/Chicago";
  it("knows when the office is open", async () => {
    const { officeOpen, DEFAULT_TEXTING_CHOICES } = await import("../src");
    const hours = DEFAULT_TEXTING_CHOICES.autoReply.hours;
    expect(officeOpen(hours, noon, tz)).toBe(true);
    expect(officeOpen(hours, night, tz)).toBe(false);
    // Saturday is closed by default.
    expect(officeOpen(hours, new Date("2026-11-28T18:00:00Z"), tz)).toBe(false);
  });
  it("quiet hours can run past midnight", async () => {
    const { inQuietHours } = await import("../src");
    expect(inQuietHours({ start: "21:00", end: "07:00" }, night, tz)).toBe(true);
    expect(inQuietHours({ start: "21:00", end: "07:00" }, noon, tz)).toBe(false);
    expect(inQuietHours({ start: "11:00", end: "13:00" }, noon, tz)).toBe(true);
    expect(inQuietHours(null, night, tz)).toBe(false);
  });
  it("the office's choices are checked", async () => {
    const { textingOptionsSchema, DEFAULT_TEXTING_CHOICES, textingChoices } = await import("../src");
    expect(textingOptionsSchema.safeParse(DEFAULT_TEXTING_CHOICES).success).toBe(true);
    expect(textingOptionsSchema.safeParse({ ...DEFAULT_TEXTING_CHOICES, autoReply: { ...DEFAULT_TEXTING_CHOICES.autoReply, enabled: true, message: "" } }).success).toBe(false);
    expect(textingOptionsSchema.safeParse({ ...DEFAULT_TEXTING_CHOICES, autoReply: { ...DEFAULT_TEXTING_CHOICES.autoReply, hours: { ...DEFAULT_TEXTING_CHOICES.autoReply.hours, mon: { open: "17:00", close: "08:00" } } } }).success).toBe(false);
    expect(textingChoices(null)).toEqual(DEFAULT_TEXTING_CHOICES);
  });
});
