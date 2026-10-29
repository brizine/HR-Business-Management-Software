import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ATTESTATIONS, W4_AMOUNTS, type DirectDeposit, type I9Section1, type I9Section2, type W4 } from "@crewdesk/shared";

/**
 * Printable records of forms completed electronically in Biz Management Software. They
 * contain the same information as the IRS/USCIS forms plus the e-signature
 * details (who, when, from where), so the employer can file or hand them over
 * on request. They aren't the official form layouts.
 */

export interface Signed {
  name: string;
  at: Date;
  ip?: string | null;
}

export interface Employer {
  name: string;
  legalName?: string | null;
  ein?: string | null;
  address?: string | null;
}

const MARGIN = 50;
const WIDTH = 612;
const HEIGHT = 792;

/** Standard PDF fonts only cover Windows-1252; anything else becomes "?". */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([WIDTH, HEIGHT]);
    this.y = HEIGHT - MARGIN;
  }
  private ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }
  private wrap(text: string, size: number, font: PDFFont, width: number) {
    const lines: string[] = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }
  text(text: string, opts: { size?: number; bold?: boolean; gap?: number; color?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    for (const line of this.wrap(text, size, font, WIDTH - 2 * MARGIN)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font, color: rgb(opts.color ?? 0, opts.color ?? 0, opts.color ?? 0) });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 2;
  }
  heading(text: string) {
    this.y -= 8;
    this.text(text, { size: 12, bold: true, gap: 4 });
  }
  field(label: string, value: string | number | boolean | null | undefined) {
    const v = value === true ? "Yes" : value === false ? "No" : value == null || value === "" ? "-" : String(value);
    const labelWidth = 200;
    const lines = this.wrap(v, 10, this.font, WIDTH - 2 * MARGIN - labelWidth);
    this.ensure(14 * lines.length);
    this.page.drawText(safe(label), { x: MARGIN, y: this.y - 10, size: 9, font: this.font, color: rgb(0.35, 0.35, 0.35) });
    lines.forEach((l, i) => this.page.drawText(l, { x: MARGIN + labelWidth, y: this.y - 10 - i * 14, size: 10, font: this.bold }));
    this.y -= 14 * lines.length + 2;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 4 }, end: { x: WIDTH - MARGIN, y: this.y - 4 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    this.y -= 12;
  }
  signature(title: string, s: Signed, statement: string) {
    this.heading(title);
    this.text(statement, { size: 9, gap: 6 });
    this.field("Signed (typed name)", s.name);
    this.field("Date and time", s.at.toISOString().replace("T", " ").slice(0, 19) + " UTC");
    if (s.ip) this.field("Signed from IP address", s.ip);
    this.text("Signed electronically in Biz Management Software.", { size: 8, color: 0.4 });
  }
}

/** Footer on every page, so a loose page can be matched to its form and employee. */
async function finish(doc: PDFDocument, label: string) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawText(safe(`${label} · Page ${i + 1} of ${pages.length}`), { x: MARGIN, y: 25, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
  });
  return doc.save();
}

async function start(title: string, subtitle: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Biz Management Software");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  w.text(title, { size: 16, bold: true });
  w.text(subtitle, { size: 9, color: 0.35, gap: 6 });
  w.rule();
  return { doc, w };
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const FILING: Record<W4["filingStatus"], string> = {
  single: "Single or Married filing separately",
  married_jointly: "Married filing jointly or Qualifying surviving spouse",
  head_of_household: "Head of household",
};

export async function w4Pdf(f: W4, signed: Signed, employer: Employer, firstDay?: string | null) {
  const { doc, w } = await start(
    "Form W-4: Employee's Withholding Certificate",
    `Completed electronically in Biz Management Software for ${employer.name}. Form year ${W4_AMOUNTS.year}. Same information as IRS Form W-4; see irs.gov/w4 for instructions.`,
  );
  w.heading("Step 1: Personal information");
  w.field("Name", `${f.firstName} ${f.middleInitial ? f.middleInitial + ". " : ""}${f.lastName}`);
  w.field("Address", `${f.address}${f.apt ? `, ${f.apt}` : ""}, ${f.city}, ${f.state} ${f.zip}`);
  w.field("Social Security number", f.ssn);
  w.field("Filing status", FILING[f.filingStatus]);
  w.heading("Step 2: Multiple jobs or spouse works");
  w.field("Checkbox in Step 2(c)", f.multipleJobs);
  w.heading("Step 3: Claim dependent and other credits");
  w.field("Qualifying children (amount)", money(f.childrenAmount));
  w.field("Other dependents (amount)", money(f.otherDependentsAmount));
  w.field("Total, Step 3", money(f.childrenAmount + f.otherDependentsAmount));
  w.heading("Step 4: Other adjustments");
  w.field("4(a) Other income (not from jobs)", money(f.otherIncome));
  w.field("4(b) Deductions", money(f.deductions));
  w.field("4(c) Extra withholding per pay period", money(f.extraWithholding));
  w.field("Claims exemption from withholding", f.exempt ? "Exempt" : "No");
  w.signature("Step 5: Sign here", signed, ATTESTATIONS.w4);
  w.heading("Employers only");
  w.field("Employer's name and address", [employer.legalName || employer.name, employer.address].filter(Boolean).join(", "));
  w.field("First date of employment", firstDay);
  w.field("Employer identification number (EIN)", employer.ein);
  return finish(doc, `Form W-4 · ${f.firstName} ${f.lastName}`);
}

const STATUS: Record<I9Section1["citizenship"], string> = {
  citizen: "1. A citizen of the United States",
  noncitizen_national: "2. A noncitizen national of the United States",
  permanent_resident: "3. A lawful permanent resident",
  authorized_alien: "4. A noncitizen (other than Item Numbers 2 and 3 above) authorized to work",
};

export async function i9Pdf(f: I9Section1, signed: Signed, employer: Employer, s2?: { data: I9Section2; signed: Signed } | null) {
  const { doc, w } = await start(
    "Form I-9: Employment Eligibility Verification",
    `Completed electronically in Biz Management Software for ${employer.name}. Same information as USCIS Form I-9; see uscis.gov/i-9 for instructions and the Lists of Acceptable Documents.`,
  );
  w.heading("Section 1: Employee information and attestation");
  w.field("Last name", f.lastName);
  w.field("First name", f.firstName);
  w.field("Middle initial", f.middleInitial);
  w.field("Other last names used", f.otherLastNames);
  w.field("Address", `${f.address}${f.apt ? `, ${f.apt}` : ""}, ${f.city}, ${f.state} ${f.zip}`);
  w.field("Date of birth", f.dateOfBirth);
  w.field("U.S. Social Security number", f.ssn);
  w.field("Email", f.email);
  w.field("Telephone", f.phone);
  w.field("Citizenship / immigration status", STATUS[f.citizenship]);
  if (f.citizenship === "permanent_resident") w.field("USCIS A-Number", f.uscisNumber);
  if (f.citizenship === "authorized_alien") {
    w.field("Work authorization expires", f.workAuthExpires);
    w.field("USCIS A-Number", f.uscisNumber);
    w.field("Form I-94 admission number", f.i94Number);
    w.field("Foreign passport number / country", f.foreignPassportNumber ? `${f.foreignPassportNumber} / ${f.passportCountry}` : "");
  }
  w.field("Used a preparer or translator", f.usedPreparer ? "Yes (Supplement A attached separately)" : "No");
  w.signature("Signature of employee", signed, ATTESTATIONS.i9);

  w.rule();
  w.heading("Section 2: Employer review and verification");
  if (!s2) {
    w.text("Not completed yet. The employer must examine the employee's documents within 3 business days of the first day of employment.", { size: 10 });
  } else {
    const d = s2.data;
    const doc_ = (label: string, x?: { title: string; issuingAuthority: string; number: string; expires?: string }) => {
      if (!x) return;
      w.field(`${label}: document title`, x.title);
      w.field(`${label}: issuing authority`, x.issuingAuthority);
      w.field(`${label}: document number`, x.number);
      w.field(`${label}: expiration date`, x.expires || "N/A");
    };
    d.listA.forEach((x, i) => doc_(`List A #${i + 1}`, x));
    doc_("List B", d.listB);
    doc_("List C", d.listC);
    w.field("Additional information", d.additionalInfo);
    w.field("Alternative procedure authorized by DHS used", d.alternativeProcedure);
    w.field("Employee's first day of employment", d.firstDayOfEmployment);
    w.signature("Certification", s2.signed, ATTESTATIONS.i9Employer);
    w.field("Title of employer or authorized representative", d.employerTitle);
    w.field("Employer's business or organization name", employer.legalName || employer.name);
    w.field("Employer's business address", employer.address);
  }
  return finish(doc, `Form I-9 · ${f.firstName} ${f.lastName}`);
}

export async function directDepositPdf(f: DirectDeposit, signed: Signed, employer: Employer, employeeName: string) {
  const { doc, w } = await start("Direct Deposit Authorization", `Completed electronically in Biz Management Software for ${employer.name}.`);
  w.field("Employee", employeeName);
  w.field("Bank", f.bankName);
  w.field("Routing number", f.routingNumber);
  w.field("Account number", f.accountNumber);
  w.field("Account type", f.accountType === "checking" ? "Checking" : "Savings");
  w.signature("Authorization", signed, ATTESTATIONS.directDeposit);
  return finish(doc, `Direct deposit · ${employeeName}`);
}
