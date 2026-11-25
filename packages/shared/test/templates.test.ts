import { describe, expect, it } from "vitest";
import { SYSTEM_TEMPLATES, fillTags, htmlToText, smsSegments, tagNeeds, templateDefaultsSchema, templateSchema, unknownTags, usedTags } from "../src";

describe("templates", () => {
  it("fills tags in, escaping values in emails and turning link tags into links", () => {
    const vars = { CUSTOMER_FIRST_NAME: "Jo <Ann>", INVOICES_LINKS: "https://pay.example.com/x?a=1&b=2", COMPANY_NAME: "Pro Spray" };
    expect(fillTags("Hi {{CUSTOMER_FIRST_NAME}} from {{ COMPANY_NAME }}{{NOPE}}", vars)).toBe("Hi Jo <Ann> from Pro Spray");
    expect(fillTags("<p>Hi {{CUSTOMER_FIRST_NAME}}: {{INVOICES_LINKS}}</p>", vars, { html: true }))
      .toBe('<p>Hi Jo &lt;Ann&gt;: <a href="https://pay.example.com/x?a=1&amp;b=2" data-cd-link="1">View and pay your invoice</a></p>');
    expect(fillTags('<a href="{{INVOICES_LINKS}}">Pay</a>', vars, { html: true })).toBe('<a href="https://pay.example.com/x?a=1&amp;b=2">Pay</a>');
    // In a text, a link is the address itself.
    expect(fillTags("Pay: {{INVOICES_LINKS}}", vars)).toBe("Pay: https://pay.example.com/x?a=1&b=2");
  });

  it("knows which tags are used, unknown, and what they need", () => {
    expect(usedTags("{{INVOICE_NUMBER}} {{CUSTOMER_NAME}}", "{{INVOICE_NUMBER}}")).toEqual(["INVOICE_NUMBER", "CUSTOMER_NAME"]);
    expect(unknownTags("{{CUSTOMER_NAM}} {{CUSTOMER_NAME}}")).toEqual(["CUSTOMER_NAM"]);
    expect(tagNeeds("{{INVOICE_TOTAL}} {{EVENT_DATE}} {{COMPANY_NAME}}")).toEqual(["invoice", "visit"]);
  });

  it("counts text segments: 160 plain characters, 70 once there's an emoji", () => {
    expect(smsSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(smsSegments("a".repeat(161))).toMatchObject({ segments: 2 });
    expect(smsSegments("{}".repeat(40))).toMatchObject({ units: 160, segments: 1 });
    expect(smsSegments("Thanks 🤩")).toMatchObject({ encoding: "Unicode", segments: 1 });
    expect(smsSegments("🤩" + "a".repeat(69))).toMatchObject({ units: 71, segments: 2 });
    expect(smsSegments("")).toMatchObject({ segments: 0 });
  });

  it("turns an email into plain text", () => {
    expect(htmlToText('<h2>Hi</h2><p>Line one<br>line two</p><ul><li>A</li><li>B</li></ul><p><a href="https://x.co">Pay now</a> &amp; thanks</p>'))
      .toBe("Hi\n\nLine one\nline two\n\n• A\n• B\n\nPay now: https://x.co & thanks");
  });

  it("checks what's saved", () => {
    expect(templateSchema.safeParse({ channel: "email", name: "X", body: "<p>Hi</p>" }).success).toBe(false);
    expect(templateSchema.safeParse({ channel: "email", name: "X", subject: "S", body: "<p> </p>" }).success).toBe(false);
    expect(templateSchema.parse({ channel: "text", name: "X", subject: "", body: "Hi" })).toMatchObject({ audience: "customer", subject: null });
    expect(templateDefaultsSchema.safeParse({ invoice: { email: null, text: null }, estimate: { email: "", text: null }, receipt: { email: null, text: null }, reviewUrl: "g.page/x" }).success).toBe(false);
  });

  it("Crewdesk's own templates only use real tags", () => {
    for (const t of SYSTEM_TEMPLATES) expect(unknownTags(t.subject, t.body)).toEqual([]);
  });
});
