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

/** The recording was made when the stub was the bottom third of the page (3.67 inches); it starts 3½ inches up now. */
const THIRDS = { stub: { fromBottom: 3.67 } };
/**
 * What's drawn for a sample invoice in a layout: Crewdesk's own (with the sample's footer, and the
 * stub where it was when the recording was made) with `layout`'s changes on top.
 */
const draw = (name: SampleName, layout?: unknown, extra: Partial<PdfInvoice> = {}) => {
  const s = SAMPLES[name];
  const base = cleanInvoiceLayout(deepMerge(resolveInvoiceLayout(null, { footer: s.footer, payableTo: s.payableTo }), THIRDS));
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

  it("an invoice with no layout at all prints in Crewdesk's own, with the stub 3½ inches up", async () => {
    const s = SAMPLES.plain;
    const ops = await recordOps((doc) => addInvoicePages(doc, s.company, s.inv as PdfInvoice));
    expect(ops).toEqual(await draw("plain", { stub: { fromBottom: 3.5 } }));
    // The tear-off line is 3.5 x 72 points from the bottom; it was 3.67 inches up. Nothing above it moved.
    const tear = (list: string[]) => num(list.find((o) => / line /.test(o) && /dash=4\/3/.test(o))!.replace(/.* line [-0-9.]+,/, "y="), "y");
    expect(tear(ops)).toBe(252);
    expect(tear(before.plain)).toBeCloseTo(264.24, 2);
    expect(op(ops, "Grub preventer")).toBe(op(before.plain, "Grub preventer"));
    expect(num(op(ops, "Make checks payable to"), "y")).toBeCloseTo(num(op(before.plain, "Make checks payable to"), "y") - 12.24, 2);
  });

  it("a shorter stub leaves more of the first page for the lines", async () => {
    const onFirst = (ops: string[]) => ops.filter((o) => o.startsWith('p1 text "Visit ')).length;
    const tall = await draw("long", { stub: { fromBottom: 4.5 } }), short = await draw("long", { stub: { fromBottom: 2.75 } });
    expect(onFirst(short)).toBeGreaterThan(onFirst(before.long));
    expect(onFirst(tall)).toBeLessThan(onFirst(before.long));
    // Every line still prints, whichever page it lands on.
    for (const ops of [tall, short]) expect(words(ops).filter((x) => /^Visit \d+: mowing$/.test(x)).length).toBe(words(before.long).filter((x) => /^Visit \d+: mowing$/.test(x)).length);
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

  it("the previous balance lines print at the top right, where the amount due was", async () => {
    // An unpaid invoice for $110.00 with $40.00 still owed from before.
    const ops = await draw("plain", { totals: { balance: { show: true } } }, { previousBalanceCents: 4000 });
    const w = words(ops);
    expect(w.slice(w.indexOf("Previous Balance"), w.indexOf("Total Amount Due") + 2)).toEqual(["Previous Balance", "$40.00", "Today's Amount", "$110.00", "Total Amount Due", "$150.00"]);
    // They follow the details and take the amount due's place: the same column, the last line as large as it was.
    expect(w.indexOf("Customer #")).toBeLessThan(w.indexOf("Previous Balance"));
    expect(w.indexOf("Total Amount Due")).toBeLessThan(w.indexOf("Jane Example"));
    const was = op(before.plain, "Amount due")!, label = op(ops, "Total Amount Due")!;
    expect(label).toMatch(/size=10 font=Helvetica-Bold/);
    expect(num(label, "y")).toBeLessThan(num(was, "y"));
    expect(num(label, "y")).toBeGreaterThan(num(op(ops, "Jane Example"), "y"));
    expect(ops.find((o) => o.includes('text "$150.00"'))).toMatch(/size=13 font=Helvetica-Bold/);
    expect(ops.find((o) => o.includes('text "$40.00"'))).toMatch(/size=9\.5 font=Helvetica /);
    // The heading "Amount due" is gone from the top (it's still on the stub), and the stub asks for the total due.
    expect(w.filter((x) => x === "Amount due")).toHaveLength(1);
    expect(w.filter((x) => x === "$150.00")).toHaveLength(2);
    // Under the lines, the totals are the invoice's own, as they always were, in the same place.
    for (const t of ["Description", "Subtotal", "Total"]) expect(op(ops, t)).toBe(op(before.plain, t));
    // Unticked, the stub keeps this invoice's amount.
    const own = words(await draw("plain", { totals: { balance: { show: true, payTotal: false } } }, { previousBalanceCents: 4000 }));
    expect(own.filter((x) => x === "$150.00")).toHaveLength(1);
    // A part-paid invoice keeps its own "Amount due" row in the totals; Today's Amount at the top is the same figure.
    const part = words(await draw("full", { totals: { balance: { show: true } } }, { previousBalanceCents: 2550 }));
    expect(part.slice(part.indexOf("Previous Balance"), part.indexOf("Total Amount Due") + 2)).toEqual(["Previous Balance", "$25.50", "Today's Amount", "$147.50", "Total Amount Due", "$173.00"]);
    expect(part.filter((x) => x === "Amount due")).toHaveLength(2);
    // With many details above them, the lines push the table down rather than run into it.
    const many = await draw("plain", { header: { details: base.header.details.map((d) => ({ ...d, show: true })) }, totals: { balance: { show: true } } }, { poNumber: "PO-1", serviceDates: ["2026-11-01"] });
    expect(num(op(many, "Total Amount Due"), "y")).toBeGreaterThan(num(op(many, "Description"), "y"));
  });

  it("or under the invoice's own totals: Previous Balance, Today's Amount and Total Amount Due", async () => {
    const on = { totals: { balance: { show: true, place: "totals" } } };
    // An unpaid invoice for $110.00 with $40.00 still owed from before.
    const ops = await draw("plain", on, { previousBalanceCents: 4000 });
    const w = words(ops);
    const at = (label: string) => w.indexOf(label);
    expect(at("Total")).toBeLessThan(at("Previous Balance"));
    expect(at("Previous Balance")).toBeLessThan(at("Today's Amount"));
    expect(at("Today's Amount")).toBeLessThan(at("Total Amount Due"));
    expect(w.slice(at("Previous Balance"), at("Total Amount Due") + 2)).toEqual(["Previous Balance", "$40.00", "Today's Amount", "$110.00", "Total Amount Due", "$150.00"]);
    expect(op(ops, "Total Amount Due")).toMatch(/font=Helvetica-Bold/);
    expect(op(ops, "Previous Balance")).toMatch(/font=Helvetica /);
    // One more rule than before, between the invoice's totals and the account's.
    expect(ops.filter((o) => / line /.test(o)).length).toBe(before.plain.filter((o) => / line /.test(o)).length + 1);
    // The amount to pay, at the top and on the stub, is the total due: $150.00 three times with the line itself.
    expect(w.filter((x) => x === "$150.00")).toHaveLength(3);
    // Unticked, the top and the stub keep this invoice's amount; the three lines stay.
    const mine = words(await draw("plain", { totals: { balance: { show: true, place: "totals", payTotal: false } } }, { previousBalanceCents: 4000 }));
    expect(mine.filter((x) => x === "$150.00")).toHaveLength(1);
    expect(mine).toContain("Total Amount Due");

    // Nothing owed from before: the lines still show, with $0.00.
    const none = words(await draw("plain", on));
    expect(none.slice(none.indexOf("Previous Balance"), none.indexOf("Total Amount Due") + 2)).toEqual(["Previous Balance", "$0.00", "Today's Amount", "$110.00", "Total Amount Due", "$110.00"]);

    // A part-paid invoice: Today's Amount is what it still comes to, and takes the place of its own "Amount due" row.
    const part = words(await draw("full", on, { previousBalanceCents: 2550 }));
    expect(part).toEqual(expect.arrayContaining(["Total", "$217.50", "Credit CR-12", "Paid"]));
    expect(part.slice(part.indexOf("Previous Balance"), part.indexOf("Total Amount Due") + 2)).toEqual(["Previous Balance", "$25.50", "Today's Amount", "$147.50", "Total Amount Due", "$173.00"]);
    // "Amount due" is still the heading at the top right and on the stub, but no longer a totals row.
    expect(part.filter((x) => x === "Amount due")).toHaveLength(2);
    expect(words(before.full).filter((x) => x === "Amount due")).toHaveLength(3);

    // Renamed, and without the invoice's own Total row.
    const named = words(await draw("plain", { totals: { rows: base.totals.rows.map((r) => (r.key === "total" ? { ...r, show: false } : r)), balance: { show: true, place: "totals", previousLabel: "Balance forward", todayLabel: "This invoice", totalLabel: "Please pay" } } }, { previousBalanceCents: 4000 }));
    expect(named).toEqual(expect.arrayContaining(["Balance forward", "This invoice", "Please pay"]));
    expect(named).not.toContain("Total");
    // With the lines off, the layout draws exactly what it always did, whatever balance comes with the invoice.
    expect(await draw("plain", undefined, { previousBalanceCents: 4000 })).toEqual(before.plain);
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
