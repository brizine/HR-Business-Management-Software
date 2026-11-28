import { PDFDocument, PDFPage } from "pdf-lib";

/**
 * Everything drawn on a PDF's pages while `fn` runs, one line each (words, lines, pictures and
 * boxes with where they went), so a test can say "this draws exactly what it drew before".
 */
export async function recordOps(fn: (doc: PDFDocument) => Promise<unknown>): Promise<string[]> {
  const ops: string[] = [];
  const n = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : "-");
  const color = (c: any) => (c ? [c.red, c.green, c.blue].map(n).join(",") : "-");
  const page = (p: PDFPage) => `p${p.doc.getPages().indexOf(p) + 1}`;
  const proto = PDFPage.prototype as any;
  const real = { drawText: proto.drawText, drawLine: proto.drawLine, drawImage: proto.drawImage, drawRectangle: proto.drawRectangle };
  proto.drawText = function (this: PDFPage, text: string, o: any = {}) {
    ops.push(`${page(this)} text ${JSON.stringify(text)} x=${n(o.x)} y=${n(o.y)} size=${n(o.size)} font=${o.font?.name ?? "-"} color=${color(o.color)}`);
    return real.drawText.call(this, text, o);
  };
  proto.drawLine = function (this: PDFPage, o: any) {
    ops.push(`${page(this)} line ${n(o.start.x)},${n(o.start.y)} to ${n(o.end.x)},${n(o.end.y)} w=${n(o.thickness)} dash=${o.dashArray ? o.dashArray.join("/") : "-"} color=${color(o.color)}`);
    return real.drawLine.call(this, o);
  };
  proto.drawImage = function (this: PDFPage, image: unknown, o: any = {}) {
    ops.push(`${page(this)} image x=${n(o.x)} y=${n(o.y)} w=${n(o.width)} h=${n(o.height)}`);
    return real.drawImage.call(this, image, o);
  };
  proto.drawRectangle = function (this: PDFPage, o: any = {}) {
    ops.push(`${page(this)} box x=${n(o.x)} y=${n(o.y)} w=${n(o.width)} h=${n(o.height)} fill=${color(o.color)} border=${color(o.borderColor)}`);
    return real.drawRectangle.call(this, o);
  };
  try {
    await fn(await PDFDocument.create());
  } finally {
    Object.assign(proto, real);
  }
  return ops;
}

/** A small PNG (a 2 x 1 picture), for a logo. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnACPhaWZ8HAAAAAElFTkSuQmCC", "base64");

/* ───────────── Sample invoices ───────────── */

export const SAMPLE_COMPANY = {
  name: "Sample Lawn & Pest", legalName: "Sample Lawn & Pest LLC", addressLine1: "100 Main St", addressLine2: "Suite 4", city: "Norman", state: "OK", zip: "73069",
  phone: "(405) 555-0100", email: "office@samplelawn.example", website: "www.samplelawn.example",
};

const line = (description: string, quantity: number, unitPriceCents: number, taxRate = 0) => ({ description, quantity, unitPriceCents, amountCents: Math.round(quantity * unitPriceCents), taxRate });

/** Three invoices that between them use every part of the page. `footer` and `payableTo` are what billing settings held. */
export const SAMPLES = {
  /** Two lines, nothing extra. */
  plain: {
    company: { ...SAMPLE_COMPANY, addressLine2: null, logo: null }, footer: "", payableTo: "",
    inv: {
      number: 1042, status: "sent", issueDate: "2026-11-20", dueDate: "2026-11-20", poNumber: null, notes: null,
      subtotalCents: 11000, discountCents: 0, totalCents: 11000, paidCents: 0, termsDays: 0,
      customerName: "Jane Example", billTo: ["12 Oak St", "Norman, OK 73069"], serviceAddress: null, customerNumber: 1007,
      lines: [line("Fertilizer & weed control round 5", 1, 6500), line("Grub preventer", 1, 4500)],
    },
  },
  /** A logo, tax, a discount, notes, a footer, a credit, a payment, a PO and the pay-online line; a copy. */
  full: {
    company: { ...SAMPLE_COMPANY, logo: TINY_PNG }, footer: "Thank you for your business! All program applications are guaranteed: if weeds come back between rounds, call us and we'll re-treat at no charge.", payableTo: "Sample Lawn & Pest LLC",
    inv: {
      number: 2051, status: "partial", issueDate: "2026-11-01", dueDate: "2026-12-01", poNumber: "PO-7781", notes: "Gate was locked on the first try; we came back Thursday.\nPlease leave the side gate unlatched for the winter round.",
      subtotalCents: 21500, discountCents: 1500, taxCents: 1750, taxName: "Sales tax", totalCents: 21750, paidCents: 5000, termsDays: 30,
      creditedCents: 2000, credits: [{ number: 12, amountCents: 2000 }],
      customerName: "Brookside Commons HOA", billTo: ["Attn: Accounts Payable", "PO Box 220", "Norman, OK 73070"], serviceAddress: "400 Brookside Dr, Norman, OK 73071", customerNumber: 1100,
      lines: [
        line("Flea & tick yard spray, back lawn only, including the dog run and the fence line along the creek where the pets spend their time", 1, 9500, 8.75),
        line("Core aeration", 2.5, 4000, 8.75),
        line("Late fee", 1, 2000),
      ],
      copy: true, payOnline: "management.example/portal/sample",
    },
  },
  /** A draft with sixty lines: three pages. */
  long: {
    company: { ...SAMPLE_COMPANY, logo: null }, footer: "Thank you!", payableTo: "",
    inv: {
      number: null, status: "draft", issueDate: "2026-10-05", dueDate: "2026-10-20", poNumber: null, notes: "Season summary.",
      subtotalCents: 60 * 3250, discountCents: 0, totalCents: 60 * 3250, paidCents: 0, termsDays: 15,
      customerName: "Sam Renter", billTo: ["77 Elm St Apt 3", "Moore, OK 73160"], serviceAddress: "77 Elm St, Moore, OK 73160", customerNumber: 1201,
      lines: Array.from({ length: 60 }, (_, i) => line(i % 7 === 3 ? `Visit ${i + 1}: mowing, edging and blowing off the walks and the drive, with the clippings bagged and hauled away because of the leaves` : `Visit ${i + 1}: mowing`, 1, 3250)),
    },
  },
};
export type SampleName = keyof typeof SAMPLES;
