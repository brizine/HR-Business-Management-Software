/**
 * The invoice PDF drawn from a layout: Crewdesk's own layout draws exactly what invoices always
 * were (checked against a recording made before the editor existed), and each thing the editor
 * can change shows up on the page. No database: these only draw.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanInvoiceLayout, resolveInvoiceLayout, type InvoiceLayout } from "@crewdesk/shared";
import { addInvoicePages, type PdfInvoice } from "../src/lib/invoicePdf";
import { SAMPLES, recordOps, type SampleName } from "./pdfOps";

const before: Record<SampleName, string[]> = JSON.parse(readFileSync(new URL("./fixtures-invoice-pdf.json", import.meta.url), "utf8"));

/** What's drawn for a sample invoice in a layout (the default with the sample's own footer when none is given). */
const draw = (name: SampleName, layout?: unknown, extra: Partial<PdfInvoice> = {}) => {
  const s = SAMPLES[name];
  const base = resolveInvoiceLayout(null, { footer: s.footer, payableTo: s.payableTo });
  const merged = layout ? cleanInvoiceLayout(deepMerge(base, layout)) : base;
  return recordOps((doc) => addInvoicePages(doc, s.company, { ...(s.inv as PdfInvoice), ...extra, layout: merged }));
};
function deepMerge(a: any, b: any): any {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k]);
  return out;
}
/** The words drawn (in order), and one drawn thing by its words. */
const words = (ops: string[]) => ops.filter((o) => / text /.test(o)).map((o) => JSON.parse(o.slice(o.indexOf('"'), o.lastIndexOf('"') + 1)) as string);
const op = (ops: string[], text: string) => ops.find((o) => o.includes(` text ${JSON.stringify(text)} `));
const num = (o: string | undefined, key: string) => Number(o?.match(new RegExp(`${key}=([-0-9.]+)`))?.[1]);
const detailsOf = (l: InvoiceLayout, change: (key: string, d: InvoiceLayout["header"]["details"][number]) => Partial<InvoiceLayout["header"]["details"][number]>) =>
  l.header.details.map((d) => ({ ...d, ...change(d.key, d) }));
const base = cleanInvoiceLayout({});

describe("the invoice PDF and its layout", () => {
  it.each(Object.keys(SAMPLES) as SampleName[])("Crewdesk's own layout draws the %s invoice exactly as before", async (name) => {
    expect(await draw(name)).toEqual(before[name]);
  });

  it("an invoice with no layout at all prints in Crewdesk's own", async () => {
    const s = SAMPLES.plain;
    expect(await recordOps((doc) => addInvoicePages(doc, s.company, s.inv as PdfInvoice))).toEqual(before.plain);
  });

  it("the title, the details and their labels follow the layout", async () => {
    const ops = await draw("full", { header: {
      title: "STATEMENT",
      details: detailsOf(base, (k) => (k === "number" ? { label: "Bill no." } : k === "customerNumber" ? { show: false } : k === "terms" ? { show: true, label: "Terms" } : {})),
      amountDue: { show: true, label: "Please pay" },
    } });
    const w = words(ops);
    expect(w).toContain("STATEMENT (COPY)");
    expect(w).not.toContain("INVOICE (COPY)");
    expect(w).toContain("Bill no.");
    expect(w).toContain("Please pay");
    // Terms have their own line now, so the due date stands alone.
    expect(w).toEqual(expect.arrayContaining(["12/1/2026", "Terms", "Net 30"]));
    expect(w).not.toContain("12/1/2026 (Net 30)");
    // The customer number is off the top; the stub still has it.
    expect(w.filter((x) => x === "Customer #")).toHaveLength(1);
    // Everything else is where it was.
    expect(op(ops, "Brookside Commons HOA")).toBe(op(before.full, "Brookside Commons HOA"));
  });

  it("details can be put in another order, and a detail with nothing to show is left off", async () => {
    const reordered = [...base.header.details].reverse();
    const ops = await draw("plain", { header: { details: reordered.map((d) => ({ ...d, show: true })) } }, { serviceDates: ["2026-11-19", "2026-11-17", "2026-11-19"] });
    const w = words(ops);
    // Service date first now (the first and last day), and no PO line: this invoice has none.
    expect(w.indexOf("Service date")).toBeLessThan(w.indexOf("Invoice #"));
    expect(w).toContain("11/17/2026 - 11/19/2026");
    expect(w).not.toContain("PO #");
    const none = words(await draw("plain", { header: { details: detailsOf(base, () => ({ show: true })) } }));
    expect(none).not.toContain("Service date");
  });

  it("a custom field shows as a detail when the invoice has a value for it", async () => {
    const key = "cf:11111111-2222-3333-4444-555555555555";
    const layout = { header: { details: [...base.header.details, { key, label: "Route", show: true }] } };
    const w = words(await draw("plain", layout, { fields: { [key]: "North 4" } }));
    expect(w).toEqual(expect.arrayContaining(["Route", "North 4"]));
    expect(words(await draw("plain", layout))).not.toContain("Route");
    // A value too long for its room is cut short rather than run over the label.
    const long = words(await draw("plain", layout, { fields: { [key]: "A very long value that could never fit beside its label" } }));
    expect(long.find((x) => x.startsWith("A very long"))).toMatch(/\.\.\.$/);
  });

  it("columns can be renamed, hidden and reordered; the description takes the room", async () => {
    const cols = (change: Record<string, object>) => ({ table: { columns: base.table.columns.map((c) => ({ ...c, ...(change[c.key] ?? {}) })) } });
    const renamed = words(await draw("plain", cols({ description: { label: "Service" }, qty: { label: "Hours" } })));
    expect(renamed).toEqual(expect.arrayContaining(["Service", "Hours", "Price", "Amount"]));
    expect(renamed).not.toContain("Qty");
    // Without Qty and Price only the amounts are left, at the right edge as always.
    const ops = await draw("plain", cols({ qty: { show: false }, price: { show: false } }));
    expect(words(ops)).not.toContain("Qty");
    expect(words(ops)).not.toContain("Price");
    expect(words(ops).filter((x) => x === "$65.00")).toHaveLength(1);
    expect(op(ops, "Amount")).toBe(op(before.plain, "Amount"));
    // Amount before Price: the price column is the one at the right edge now.
    const swapped = await draw("plain", { table: { columns: ["description", "qty", "amount", "price"].map((k) => base.table.columns.find((c) => c.key === k)!) } });
    const right = (o: string | undefined) => Math.round(num(o, "x"));
    expect(right(op(swapped, "Price"))).toBeGreaterThan(right(op(swapped, "Amount")));
    // The Tax column only shows when a line is taxed, and can be hidden even then.
    expect(words(before.plain)).not.toContain("Tax");
    expect(words(before.full)).toContain("Tax");
    expect(words(await draw("full", cols({ tax: { show: false } })))).not.toContain("Tax");
  });

  it("the look: accent colour, heading bar, stripes, typeface and text size", async () => {
    const colored = await draw("full", { page: { accent: "#0a7a3b" }, table: { head: "bar", stripes: true } });
    expect(op(colored, "INVOICE (COPY)")).toMatch(/color=0\.039,0\.478,0\.231$/);
    // A filled bar behind white headings, no rule under them, and a shaded second line.
    const boxes = colored.filter((o) => / box /.test(o));
    expect(boxes.filter((o) => /fill=0\.039,0\.478,0\.231/.test(o))).toHaveLength(1);
    expect(boxes.filter((o) => /fill=0\.955,0\.96,0\.968/.test(o))).toHaveLength(1);
    expect(op(colored, "Description")).toMatch(/color=1,1,1$/);
    expect(colored.filter((o) => / line /.test(o)).length).toBe(before.full.filter((o) => / line /.test(o)).length - 1);
    expect(before.full.some((o) => / box /.test(o))).toBe(false);

    const times = await draw("plain", { page: { font: "times" } });
    expect(op(times, "INVOICE")).toMatch(/font=Times-Bold/);
    expect(op(times, "Jane Example")).toMatch(/font=Times-Bold/);
    expect(times.some((o) => /font=Helvetica/.test(o))).toBe(false);

    const large = await draw("plain", { page: { size: "large" } }), small = await draw("plain", { page: { size: "small" } });
    expect(num(op(large, "Grub preventer"), "size")).toBeCloseTo(9.5 * 1.08, 3);
    expect(num(op(small, "Grub preventer"), "size")).toBeCloseTo(9.5 * 0.92, 3);
    // Bigger words take more room: the second line sits lower on the page.
    expect(num(op(large, "Grub preventer"), "y")).toBeLessThan(num(op(before.plain, "Grub preventer"), "y"));
    // The envelope windows don't move.
    expect(num(op(large, "Jane Example"), "x")).toBe(num(op(before.plain, "Jane Example"), "x"));
  });

  it("the logo can be hidden, resized, or put on the right above the title", async () => {
    const image = (ops: string[]) => ops.find((o) => / image /.test(o));
    expect(image(before.full)).toBe("p1 image x=36 y=725.6 w=68 h=34");
    expect(image(await draw("full", { header: { logo: { show: false } } }))).toBeUndefined();
    expect(image(await draw("full", { header: { logo: { size: "large" } } }))).toBe("p1 image x=36 y=713.6 w=92 h=46");
    const right = await draw("full", { header: { logo: { place: "right" } } });
    expect(image(right)).toBe("p1 image x=508 y=725.6 w=68 h=34");
    // The title moves down under it; the company name moves up to where the logo was.
    expect(num(op(right, "INVOICE (COPY)"), "y")).toBeLessThan(num(op(before.full, "INVOICE (COPY)"), "y"));
    expect(num(op(right, "Sample Lawn & Pest"), "y")).toBeGreaterThan(num(op(before.full, "Sample Lawn & Pest"), "y"));
  });

  it("the company lines at the top can be chosen", async () => {
    const w = words(await draw("plain", { header: { company: { address: false, phone: false, email: true, website: true } } }));
    expect(w).toContain("office@samplelawn.example · www.samplelawn.example");
    // The address is still on the stub, for mailing the payment.
    expect(w.filter((x) => x === "100 Main St")).toHaveLength(1);
  });

  it("totals: labels change, and the subtotal, credit and paid rows can be left off", async () => {
    const rows = (change: Record<string, object>) => ({ totals: { rows: base.totals.rows.map((r) => ({ ...r, ...(change[r.key] ?? {}) })) } });
    const w = words(await draw("full", rows({ total: { label: "Invoice total" }, tax: { label: "OK sales tax" }, credit: { label: "Account credit" }, due: { label: "Balance due" } })));
    expect(w).toEqual(expect.arrayContaining(["Invoice total", "OK sales tax (8.75%)", "Account credit CR-12", "Balance due"]));
    const less = words(await draw("full", rows({ subtotal: { show: false }, credit: { show: false }, paid: { show: false } })));
    expect(less).not.toContain("Subtotal");
    expect(less).not.toContain("Credit CR-12");
    expect(less).not.toContain("Paid");
    // The discount, the total and what's still owed always show.
    expect(less).toEqual(expect.arrayContaining(["Discount", "Total", "Amount due"]));
  });

  it("notes sit beside the totals or under them, with a heading if wanted, or not at all", async () => {
    const first = "Gate was locked on the first try; we came back Thursday.";
    const beside = before.full, total = (ops: string[]) => num(op(ops, "Subtotal"), "y");
    // Level with the first total (their words are half a point apart in size).
    expect(Math.abs(num(op(beside, first), "y") - total(beside))).toBeLessThanOrEqual(0.5);
    const below = await draw("full", { notes: { place: "below", label: "A note from us" } });
    expect(num(op(below, "A note from us"), "y")).toBeLessThan(num(op(below, "Amount due"), "y"));
    expect(op(below, "A note from us")).toMatch(/font=Helvetica-Bold/);
    expect(words(await draw("full", { notes: { show: false } }))).not.toContain(first);
  });

  it("the footer can be centered or left off, and fill-ins in it are filled", async () => {
    const centered = await draw("plain", { footer: { text: "Thank you, {{CUSTOMER_FIRST_NAME}}! Questions? {{COMPANY_PHONE}} {{NOT_A_TAG}}", align: "center" } }, { vars: { CUSTOMER_FIRST_NAME: "Jane", COMPANY_PHONE: "(405) 555-0100" } });
    const line = centered.find((o) => o.includes("Thank you, Jane! Questions? (405) 555-0100"))!;
    expect(line).toBeTruthy();
    // Centered on the page: the middle of the words is the middle of the paper (a made-up fill-in prints as nothing).
    expect(line).not.toContain("NOT_A_TAG");
    expect(words(await draw("full", { footer: { show: false } })).some((x) => x.startsWith("Thank you for your business"))).toBe(false);
  });

  it("text blocks print where the order puts them, in their own style", async () => {
    const a = { id: "aaaa1111", text: "Winter round starts {{CURRENT_MONTH}}.\nCall to add aeration.", align: "left", size: "large", bold: true, box: true };
    const b = { id: "bbbb2222", text: "We guarantee every application.", align: "center", size: "small", bold: false, box: false };
    const ops = await draw("plain", { blocks: [a, b], order: ["text:aaaa1111", "lines", "totals", "text:bbbb2222", "footer"] }, { vars: { CURRENT_MONTH: "December" } });
    const top = op(ops, "Winter round starts December."), promise = op(ops, "We guarantee every application.");
    expect(top).toMatch(/size=12 font=Helvetica-Bold/);
    expect(promise).toMatch(/size=8\.5 font=Helvetica /);
    // The first block is above the table (which moved down to make room), in a box; the second is under the totals.
    expect(num(top, "y")).toBeGreaterThan(num(op(ops, "Description"), "y"));
    expect(num(op(ops, "Description"), "y")).toBeLessThan(num(op(before.plain, "Description"), "y"));
    expect(num(promise, "y")).toBeLessThan(num(op(ops, "Total"), "y"));
    expect(ops.filter((o) => / box /.test(o) && /fill=- border=0\.82,0\.84,0\.87/.test(o))).toHaveLength(1);
    // An empty block takes no room.
    const empty = await draw("plain", { blocks: [{ ...b, text: "  " }], order: ["text:bbbb2222", "lines", "totals", "footer"] });
    expect(op(empty, "Description")).toBe(op(before.plain, "Description"));
  });

  it("the stub's wording follows the layout, and without the stub the lines use the whole first page", async () => {
    const w = words(await draw("full", { stub: { detach: "Tear here", payableLabel: "Checks to", payableTo: "Sample Holdings", mailLabel: "Send to", payOnlineLabel: "Pay online", enclosedLabel: "You paid" } }));
    expect(w).toEqual(expect.arrayContaining(["Tear here", "Checks to", "Sample Holdings", "Send to", "Pay online", "You paid"]));
    const quiet = words(await draw("full", { stub: { payOnline: false, enclosed: false } }));
    expect(quiet).not.toContain("management.example/portal/sample");
    expect(quiet).not.toContain("Amount enclosed");
    // Without the stub more lines fit on the first page (and nothing is said about detaching).
    const onFirst = (ops: string[]) => ops.filter((o) => o.startsWith('p1 text "Visit ')).length;
    const none = await draw("long", { stub: { show: false } });
    expect(onFirst(none)).toBeGreaterThan(onFirst(before.long) + 8);
    expect(words(none)).not.toContain("Please detach and return this part with your payment");
    expect(words(none)).not.toContain("Make checks payable to");
  });

  it("what doesn't fit goes onto another page instead of being lost", async () => {
    const pages = (ops: string[]) => new Set(ops.map((o) => o.split(" ")[0])).size;
    const footer = Array.from({ length: 40 }, (_, i) => `Footer line ${i + 1} with enough words to be a line of its own on the page.`).join("\n");
    const ops = await draw("full", { footer: { text: footer.slice(0, 1000) } });
    const drawn = words(ops).filter((x) => x.startsWith("Footer line"));
    expect(drawn.length).toBeGreaterThan(10);
    expect(drawn.length).toBe(footer.slice(0, 1000).split("\n").length);
    expect(pages(ops)).toBe(2);
    // Many details push the table down rather than run into it.
    const many = await draw("plain", { header: { details: [...base.header.details.map((d) => ({ ...d, show: true })), ...Array.from({ length: 9 }, (_, i) => ({ key: `cf:00000000-0000-0000-0000-00000000000${i}`, label: `Field ${i}`, show: true }))] } },
      { poNumber: "PO-1", serviceDates: ["2026-11-01"], fields: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`cf:00000000-0000-0000-0000-00000000000${i}`, `Value ${i}`])) });
    expect(num(op(many, "Description"), "y")).toBeLessThan(num(op(many, "Field 8"), "y"));
    expect(num(op(many, "Description"), "y")).toBeLessThan(num(op(before.plain, "Description"), "y"));
  });
});
