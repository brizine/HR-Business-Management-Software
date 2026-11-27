import { describe, expect, it } from "vitest";
import { contactChannel, contactName, contactPhone, customerName, customerSchema, dayBefore, formatAddress, lawnTotal, propertyContactSchema, propertySchema } from "../src/customers";

describe("customers", () => {
  it("names commercial and HOA accounts by company, people by name", () => {
    expect(customerName({ kind: "residential", firstName: "Jane", lastName: "Example" })).toBe("Jane Example");
    expect(customerName({ kind: "commercial", firstName: "Sam", lastName: "Lee", companyName: "Smith Rentals" })).toBe("Smith Rentals");
    expect(customerName({ kind: "residential", companyName: "Lee Family Trust" })).toBe("Lee Family Trust");
    expect(customerName({})).toBe("Unnamed customer");
  });

  it("needs a name and an address for each delivery method", () => {
    const ok = customerSchema.safeParse({ firstName: "Jane", lastName: "Example", email: "Jane@Example.com", phone: "4055550100" });
    expect(ok.success && ok.data).toMatchObject({ email: "jane@example.com", phone: "(405) 555-0100", delivery: ["email"], billingState: "OK", status: "active" });
    const issues = (input: object) => { const r = customerSchema.safeParse(input); return r.success ? [] : r.error.issues.map((i) => i.path.join(".")); };
    expect(issues({ delivery: ["email"] })).toEqual(expect.arrayContaining(["lastName", "email"]));
    expect(issues({ lastName: "Doe", delivery: ["paper", "text"] })).toEqual(expect.arrayContaining(["billingStreet", "phone"]));
    expect(issues({ kind: "commercial", firstName: "Sam", email: "a@b.co" })).toContain("companyName");
    expect(issues({ lastName: "Doe", email: "a@b.co", billingZip: "7306" })).toContain("billingZip");
  });

  it("properties: address required; lawn total from front and back", () => {
    expect(propertySchema.safeParse({ city: "Norman" }).success).toBe(false);
    expect(lawnTotal({ frontSqFt: 4000.4, backSqFt: 6200 })).toBe(10200);
    expect(lawnTotal({ lawnSqFt: 8000 })).toBe(8000);
    expect(lawnTotal({})).toBeNull();
    expect(formatAddress({ street: "1601 Deskin Dr", city: "Norman", state: "OK", zip: "73069" })).toBe("1601 Deskin Dr, Norman, OK 73069");
    expect(formatAddress({ street: "9 Birch Rd" })).toBe("9 Birch Rd");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});

describe("inactive is the word on screen", () => {
  it("a cancelled customer or property reads Inactive; a retired asset reads inactive", async () => {
    const { CUSTOMER_STATUS_LABELS, statusWord, defaultLabel, CUSTOMER_FILTER_FIELDS } = await import("../src");
    expect(CUSTOMER_STATUS_LABELS).toEqual({ lead: "Lead", active: "Active", cancelled: "Inactive" });
    expect(statusWord("cancelled")).toBe("inactive");
    expect(statusWord("active")).toBe("active");
    expect(statusWord(null)).toBe("");
    // The stored values don't change, so saved filters and exports keep working.
    expect(CUSTOMER_FILTER_FIELDS.find((f) => f.key === "status")?.options).toEqual([["active", "Active"], ["lead", "Lead"], ["cancelled", "Inactive"]]);
    // Asset status: "retired" is still what's stored; a company's own wording (Edit drop-down menus) still wins.
    expect(defaultLabel("retired")).toBe("inactive");
    expect(defaultLabel("out_of_service")).toBe("out of service");
  });
});

describe("property contacts (tenants and the like)", () => {
  it("names them by first and last name, or the nickname when that's all there is", () => {
    expect(contactName({ firstName: " Tina ", lastName: "Tenant", nickname: "T" })).toBe("Tina Tenant");
    expect(contactName({ firstName: null, lastName: "Tenant" })).toBe("Tenant");
    expect(contactName({ nickname: "Bud" })).toBe("Bud");
  });

  it("shows the cell first, then home, work and other", () => {
    expect(contactPhone({ homePhone: "(405) 555-0140", cellPhone: "(405) 555-0142" })).toBe("(405) 555-0142");
    expect(contactPhone({ workPhone: "(405) 555-0141", otherPhone: "(405) 555-0143" })).toBe("(405) 555-0141");
    expect(contactPhone({ email: "t@example.com" })).toBeNull();
  });

  it("reaches them by their form of contact when they have what it needs, else email, then a text, then a call", () => {
    const all = { email: "t@example.com", cellPhone: "(405) 555-0142", homePhone: "(405) 555-0140" };
    expect(contactChannel(all)).toBe("email");
    expect(contactChannel({ ...all, formOfContact: "text" })).toBe("text");
    expect(contactChannel({ ...all, formOfContact: "call" })).toBe("call");
    // Text is picked but there's no cell phone: the next thing they do have.
    expect(contactChannel({ email: "t@example.com", homePhone: "(405) 555-0140", formOfContact: "text" })).toBe("email");
    expect(contactChannel({ cellPhone: "(405) 555-0142" })).toBe("text");
    // A land line can't get a text: the office calls.
    expect(contactChannel({ homePhone: "(405) 555-0140" })).toBe("call");
    expect(contactChannel({})).toBeNull();
  });

  it("the form needs a name, and anyone ticked for notifications needs a way to be reached", () => {
    expect(propertyContactSchema.safeParse({ nickname: "Bud" }).success).toBe(false);
    expect(propertyContactSchema.safeParse({ lastName: "Tenant", notify: true }).success).toBe(false);
    const ok = propertyContactSchema.parse({ firstName: "Tina", cellPhone: "4055550142", formOfContact: "", birthday: "", notify: true });
    expect(ok).toMatchObject({ firstName: "Tina", relation: "Tenant", cellPhone: "(405) 555-0142", formOfContact: null, notify: true });
    expect(ok.birthday).toBeUndefined();
    // A fax number alone isn't a way to send a notification.
    expect(propertyContactSchema.safeParse({ firstName: "Tina", fax: "4055550149", notify: true }).success).toBe(false);
  });
});
