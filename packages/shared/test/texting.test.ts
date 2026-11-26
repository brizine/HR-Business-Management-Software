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
