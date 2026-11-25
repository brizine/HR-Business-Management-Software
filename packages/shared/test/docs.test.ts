import { describe, expect, it } from "vitest";
import { DOC_TAGS, docCustomersSchema, docEmailSchema, docHistoryText, docImportSchema, docPreviewSchema, docPrintSchema, docSchema, docWords, fillTags, templateTag, unknownTags, usedTags } from "../src";

describe("documents", () => {
  it("every fill-in on the Insert Customer / Company Info list is a real tag", () => {
    expect(DOC_TAGS.length).toBeGreaterThan(20);
    for (const t of DOC_TAGS) expect(templateTag(t.tag), t.label).toBeTruthy();
    expect(DOC_TAGS[0]).toEqual({ label: "COMPANY NAME", tag: "COMPANY_NAME" });
  });

  it("Homeworks' document names for the portal links fill in like Crewdesk's", () => {
    const vars = { CLIENT_PORTAL_LINK: "https://x.test/portal", CUSTOMER_NAME: "Ann Lee" };
    expect(fillTags("See {{CUSTOMER_PORTAL_LINK}}", vars)).toBe("See https://x.test/portal");
    expect(fillTags("<p>{{CUSTOMER_PORTAL_LINK}}</p>", vars, { html: true })).toContain('<a href="https://x.test/portal"');
    // On paper the address is printed, not friendly words.
    expect(fillTags("<p>{{CUSTOMER_PORTAL_LINK}}</p>", vars, { html: true, plainLinks: true })).toBe("<p>https://x.test/portal</p>");
    expect(unknownTags("{{CUSTOMER_PORTAL_LINK}} {{CUSTOMER_PORTAL_ADD_CREDIT_CARD_LINK}} {{NOPE}}")).toEqual(["NOPE"]);
    expect(usedTags("{{CUSTOMER_PORTAL_LINK}}")).toEqual(["CLIENT_PORTAL_LINK"]);
  });

  it("a document needs a name and some words", () => {
    expect(docSchema.safeParse({ name: " Thank You ", content: "<p>Hi</p>" }).data).toEqual({ name: "Thank You", content: "<p>Hi</p>" });
    expect(docSchema.safeParse({ name: "", content: "<p>Hi</p>" }).error?.issues[0].message).toBe("Please enter the name");
    expect(docSchema.safeParse({ name: "x", content: "<p> </p><p><br></p>" }).error?.issues[0].message).toBe("Please enter the content");
    expect(docSchema.safeParse({ name: "x".repeat(101), content: "<p>Hi</p>" }).success).toBe(false);
    expect(docWords("<p>Dear {{CUSTOMER_NAME}},</p><p>Thank you<br>very much</p>")).toBe(6);
    expect(docWords("<p></p>")).toBe(0);
  });

  it("the pop-ups need at least one customer; a blank email template means the document is the email", () => {
    const id = "3b1f8c2e-9a7d-4c5e-8f10-2d3e4f5a6b7c";
    expect(docCustomersSchema.safeParse({ customerIds: [] }).error?.issues[0].message).toBe("Please select at least one customer");
    expect(docCustomersSchema.safeParse({}).error?.issues[0].message).toBe("Please select at least one customer");
    expect(docCustomersSchema.safeParse({ customerIds: Array(201).fill(id) }).success).toBe(false);
    expect(docEmailSchema.parse({ emailTemplateId: "" })).toEqual({ emailTemplateId: null, attachPdf: false });
    expect(docPrintSchema.parse({})).toEqual({ only: "all", preview: false });
    expect(docPreviewSchema.parse({ customerId: id })).toEqual({ customerId: id, emailTemplateId: null });
  });

  it("history reads like Homeworks', with what was emailed and printed", () => {
    expect(docHistoryText("created", null)).toEqual({ verb: "Created", rest: "" });
    expect(docHistoryText("updated", null).verb).toBe("Updated");
    expect(docHistoryText("printed", { customers: 3 })).toEqual({ verb: "Printed", rest: " for 3 customers" });
    expect(docHistoryText("emailed", { customers: 2, sent: 1, failed: 1, skipped: 1, done: true, error: "Mailbox full" }).rest).toBe(" to 1 customer, 1 failed: Mailbox full, 1 skipped");
    expect(docHistoryText("emailed", { customers: 5, sent: 2, done: false }).rest).toBe(" to 5 customers (2 sent so far)");
    expect(docHistoryText("emailed", { customers: 5, sent: 2, skipped: 3, done: true, stopped: true }).rest).toBe(" to 2 customers, 3 skipped, stopped early");
  });

  it("the import file is a list of document templates", () => {
    expect(docImportSchema.safeParse({ documentTemplates: [] }).success).toBe(false);
    expect(docImportSchema.parse({ documentTemplates: [{ name: "Thank You", content: "Hi", homeworksId: 2885 }] }).source).toBe("homeworks");
  });
});
