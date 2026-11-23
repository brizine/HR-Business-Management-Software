import { describe, expect, it } from "vitest";
import { customerEmailSchema, fillMessage, unknownFields } from "../src/customerMessages";

describe("customer email fill-in fields", () => {
  it("fills known fields, any case and spacing; leaves unknown words alone", () => {
    const t = "Hi {first_name}, you owe { Balance }. Next visit: {next_service}. {nope} {}";
    expect(fillMessage(t, { first_name: "Ann", balance: "$12.00", next_service: "Apr 4, 2027" })).toBe("Hi Ann, you owe $12.00. Next visit: Apr 4, 2027. {nope} {}");
  });
  it("a missing value becomes blank", () => {
    expect(fillMessage("Dear {first_name} {last_name}", { first_name: "Cedar Park HOA" })).toBe("Dear Cedar Park HOA ");
  });
  it("lists typos once", () => {
    expect(unknownFields("{frist_name} {frist_name} {name} {balanse}")).toEqual(["{frist_name}", "{balanse}"]);
  });
  it("needs a subject and a message", () => {
    expect(customerEmailSchema.safeParse({ subject: " ", body: "x" }).success).toBe(false);
    expect(customerEmailSchema.safeParse({ subject: "Spring", body: "  " }).success).toBe(false);
    expect(customerEmailSchema.parse({ subject: " Spring ", body: "Hi " })).toEqual({ subject: "Spring", body: "Hi" });
  });
});
