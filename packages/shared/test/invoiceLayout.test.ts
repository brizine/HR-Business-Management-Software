import { describe, expect, it } from "vitest";
import {
  COLUMN_KEYS, DEFAULT_INVOICE_LAYOUT, DETAIL_KEYS, INVOICE_LAYOUT_TAGS, LAYOUT_INK, MAX_TEXT_BLOCKS, TOTAL_KEYS,
  cleanInvoiceLayout, invoiceLayoutSchema, layoutFieldIds, layoutTags, newTextBlock, resolveInvoiceLayout, sameLayout, unknownLayoutTags,
} from "../src/invoiceLayout";

const FIELD = "cf:11111111-2222-3333-4444-555555555555";

describe("invoice layout", () => {
  it("the default is the invoice as it always printed", () => {
    const l = DEFAULT_INVOICE_LAYOUT;
    expect(l.page).toEqual({ accent: LAYOUT_INK, font: "helvetica", size: "normal" });
    expect(l.header.title).toBe("INVOICE");
    expect(l.header.logo).toEqual({ show: true, size: "normal", place: "left" });
    // Terms ride along with the due date and there's no service date until they're turned on.
    expect(l.header.details.map((d) => [d.key, d.label, d.show])).toEqual([
      ["number", "Invoice #", true], ["date", "Date", true], ["due", "Due", true], ["terms", "Terms", false], ["customerNumber", "Customer #", true], ["po", "PO #", true], ["serviceDate", "Service date", false],
    ]);
    expect(l.table.columns.map((c) => [c.key, c.label, c.show])).toEqual([["description", "Description", true], ["qty", "Qty", true], ["price", "Price", true], ["tax", "Tax", true], ["amount", "Amount", true]]);
    expect(l.totals.rows.map((r) => r.key)).toEqual([...TOTAL_KEYS]);
    expect(l.order).toEqual(["lines", "totals", "footer"]);
    expect(l.stub).toMatchObject({ show: true, payableLabel: "Make checks payable to", payableTo: "", payOnline: true });
    expect(l.blocks).toEqual([]);
  });

  it("until a layout is published, the footer and payable-to typed in billing settings are used", () => {
    const l = resolveInvoiceLayout(null, { footer: "Thank you!", payableTo: "Sample Lawn LLC" });
    expect(l.footer).toMatchObject({ show: true, text: "Thank you!" });
    expect(l.stub.payableTo).toBe("Sample Lawn LLC");
    // A published layout has its own, even when they're empty.
    const mine = resolveInvoiceLayout({ ...DEFAULT_INVOICE_LAYOUT, footer: { show: true, text: "", align: "left" } }, { footer: "Thank you!", payableTo: "Sample Lawn LLC" });
    expect(mine.footer.text).toBe("");
    expect(mine.stub.payableTo).toBe("");
  });

  it("cleans what's saved: bad choices fall back, words are trimmed, and nothing unknown gets in", () => {
    const l = cleanInvoiceLayout({
      page: { accent: "red; background:url(x)", font: "comic", size: "huge" },
      header: { title: "  STATEMENT   OF  WORK  ", logo: { show: "yes", size: "large", place: "middle" }, amountDue: { show: false, label: "x".repeat(200) }, extra: "<script>" },
      footer: { show: true, text: "  Thanks!  \r\n\r\n  ", align: "justify" },
      junk: { a: 1 },
    });
    expect(l.page).toEqual({ accent: LAYOUT_INK, font: "helvetica", size: "normal" });
    expect(l.header.title).toBe("STATEMENT OF WORK");
    expect(l.header.logo).toEqual({ show: true, size: "large", place: "left" });
    expect(l.header.amountDue).toEqual({ show: false, label: "x".repeat(30) });
    expect(l.footer).toEqual({ show: true, text: "Thanks!", align: "left" });
    expect(l).not.toHaveProperty("junk");
    expect(l.header).not.toHaveProperty("extra");
    // Not a layout at all: the default.
    for (const bad of [null, "nope", 7, [], { page: "x" }]) expect(cleanInvoiceLayout(bad).header.title).toBe("INVOICE");
    expect(cleanInvoiceLayout({ page: { accent: "#AABBCC" } }).page.accent).toBe("#aabbcc");
    expect(invoiceLayoutSchema.parse({ header: { title: "BILL" } }).header.title).toBe("BILL");
  });

  it("keeps every detail, column and total once, in the order chosen, with new ones added", () => {
    const l = cleanInvoiceLayout({
      header: { details: [
        { key: "po", label: "Purchase order", show: true }, { key: "po", label: "again", show: true }, { key: FIELD, label: "Route", show: true },
        { key: "cf:not-a-field", label: "x", show: true }, { key: "number", label: "", show: true }, { key: "made-up", label: "x", show: true },
      ] },
      table: { columns: [{ key: "amount", label: "Total", show: false }, { key: "qty", label: "Hours", show: false }, { key: "description", label: "Service", show: false }] },
      totals: { rows: [{ key: "total", label: "Invoice total", show: false }, { key: "paid", label: "Payments", show: false }, { key: "subtotal", label: "", show: false }] },
    });
    // Their order first, then the ones they never placed. A blank label takes its usual name.
    expect(l.header.details.map((d) => d.key)).toEqual(["po", FIELD, "number", "date", "due", "terms", "customerNumber", "serviceDate"]);
    expect(l.header.details[0].label).toBe("Purchase order");
    expect(l.header.details[2].label).toBe("Invoice #");
    expect(layoutFieldIds(l)).toEqual([FIELD.slice(3)]);
    // Description always leads; it and Amount can't be hidden.
    expect(l.table.columns.map((c) => [c.key, c.label, c.show])).toEqual([["description", "Service", true], ["amount", "Total", true], ["qty", "Hours", false], ["price", "Price", true], ["tax", "Tax", true]]);
    expect(COLUMN_KEYS.every((k) => l.table.columns.some((c) => c.key === k))).toBe(true);
    // Totals stay in their own order; only the subtotal, credit and paid rows can be left off.
    expect(l.totals.rows.map((r) => [r.key, r.label, r.show])).toEqual([
      ["subtotal", "Subtotal", false], ["discount", "Discount", true], ["tax", "", true], ["total", "Invoice total", true], ["credit", "Credit", true], ["paid", "Payments", false], ["due", "Amount due", true],
    ]);
    expect(DETAIL_KEYS.every((k) => l.header.details.some((d) => d.key === k))).toBe(true);
  });

  it("text blocks sit in the order with the fixed sections, each once", () => {
    const a = { ...newTextBlock(), id: "aaaa1111", text: "We guarantee every application." }, b = { ...newTextBlock(), id: "bbbb2222", text: "Spring aeration is booking now.", box: true, align: "center" as const };
    const l = cleanInvoiceLayout({ blocks: [a, b, { ...a, text: "copy" }, { id: "BAD ID", text: "x" }], order: ["text:bbbb2222", "lines", "text:gone", "totals", "lines"] });
    expect(l.blocks.map((x) => x.id)).toEqual(["aaaa1111", "bbbb2222"]);
    // What they placed, then whatever was missing (the footer and the other block).
    expect(l.order).toEqual(["text:bbbb2222", "lines", "totals", "footer", "text:aaaa1111"]);
    const many = cleanInvoiceLayout({ blocks: Array.from({ length: 12 }, (_, i) => ({ ...newTextBlock(), id: `blk${String(i).padStart(5, "0")}` })) });
    expect(many.blocks).toHaveLength(MAX_TEXT_BLOCKS);
    expect(many.order).toHaveLength(3 + MAX_TEXT_BLOCKS);
    expect(newTextBlock().id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("knows which fill-ins a layout uses, and which an invoice can't fill", () => {
    const l = cleanInvoiceLayout({
      footer: { show: true, text: "Thank you {{CUSTOMER_FIRST_NAME}}! Questions? Call {{COMPANY_PHONE}}." },
      blocks: [{ ...newTextBlock(), id: "aaaa1111", text: "Balance on your account: {{CUSTOMER_ACCOUNT_BALANCE}}. {{ESTIMATE_TOTAL}} {{NOT_A_TAG}}" }],
    });
    expect(layoutTags(l).sort()).toEqual(["COMPANY_PHONE", "CUSTOMER_ACCOUNT_BALANCE", "CUSTOMER_FIRST_NAME", "ESTIMATE_TOTAL", "NOT_A_TAG"]);
    expect(unknownLayoutTags(l).sort()).toEqual(["ESTIMATE_TOTAL", "NOT_A_TAG"]);
    // A hidden footer's fill-ins aren't looked up.
    expect(layoutTags({ ...l, footer: { ...l.footer, show: false } })).not.toContain("COMPANY_PHONE");
    const tags = INVOICE_LAYOUT_TAGS.map((t) => t.tag);
    expect(tags).toEqual(expect.arrayContaining(["CUSTOMER_NAME", "INVOICE_NUMBER", "INVOICE_DUE_DATE", "COMPANY_PHONE", "TODAY"]));
    for (const no of ["UNSUBSCRIBE", "ESTIMATE_TOTAL", "EVENT_DATE", "PAYMENT_AMOUNT", "MESSAGE"]) expect(tags).not.toContain(no);
  });

  it("tells whether two layouts print the same", () => {
    expect(sameLayout(DEFAULT_INVOICE_LAYOUT, {})).toBe(true);
    expect(sameLayout(DEFAULT_INVOICE_LAYOUT, { header: { title: "INVOICE " } })).toBe(true);
    expect(sameLayout(DEFAULT_INVOICE_LAYOUT, { header: { title: "BILL" } })).toBe(false);
  });
});
