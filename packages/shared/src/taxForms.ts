import { z } from "zod";

/**
 * Electronic tax and employment forms collected in Biz Management Software when a company
 * runs payroll manually (or wants records in one place): federal Form W-4,
 * Form I-9, and a direct deposit authorization.
 *
 * The field lists follow the current IRS/USCIS forms. Re-check them each
 * January (W-4) and whenever USCIS publishes a new I-9 edition.
 */
export const TAX_FORM_TYPES = ["w4", "i9", "direct_deposit"] as const;
export type TaxFormType = (typeof TAX_FORM_TYPES)[number];

export const TAX_FORM_LABELS: Record<TaxFormType, string> = {
  w4: "Form W-4 (federal tax withholding)",
  i9: "Form I-9 (employment eligibility)",
  direct_deposit: "Direct deposit authorization",
};

/** Onboarding tasks can require one of these; "i9_section2" is the employer's part, done by an admin. */
export const ONBOARDING_FORM_TYPES = ["w4", "i9", "direct_deposit", "i9_section2"] as const;
export type OnboardingFormType = (typeof ONBOARDING_FORM_TYPES)[number];

/** Dollar amounts used by the W-4 Step 3 helper. Check against the current year's Form W-4 each January. */
export const W4_AMOUNTS = { year: 2026, perChildUnder17: 2200, perOtherDependent: 500 };

/** Statements the person signs, word for word from the forms. */
export const ATTESTATIONS = {
  w4: "Under penalties of perjury, I declare that this certificate, to the best of my knowledge and belief, is true, correct, and complete.",
  i9: "I am aware that federal law provides for imprisonment and/or fines for false statements, or the use of false documents, in connection with the completion of this form. I attest, under penalty of perjury, that this information, including my selection of the box attesting to my citizenship or immigration status, is true and correct.",
  i9Employer:
    "I attest, under penalty of perjury, that (1) I have examined the documentation presented by the above-named employee, (2) the above-listed documentation appears to be genuine and to relate to the employee named, and (3) to the best of my knowledge, the employee is authorized to work in the United States.",
  directDeposit:
    "I authorize my employer to deposit my pay into the account above, and, if an amount is deposited in error, to correct it. This authorization stays in effect until I give my employer written notice to change or cancel it.",
};

const SSN_RE = /^(?!000|666|9\d\d)\d{3}-?(?!00)\d{2}-?(?!0000)\d{4}$/;

/** Accepts 123-45-6789 or 123456789 and returns 123-45-6789; rejects numbers the SSA never issues. */
export const ssnSchema = z
  .string()
  .trim()
  .regex(SSN_RE, "Enter a valid Social Security number (123-45-6789)")
  .transform((s) => s.replace(/\D/g, "").replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3"));

/** ABA routing numbers carry a checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function isValidRoutingNumber(s: string) {
  if (!/^\d{9}$/.test(s)) return false;
  const d = s.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** "***-**-6789", "••••4321": what lists and managers-adjacent screens show. */
export const maskSsn = (ssn?: string | null) => (ssn ? `***-**-${ssn.slice(-4)}` : "");
export const maskAccount = (acct?: string | null) => (acct ? `••••${acct.slice(-4)}` : "");

const money = z.number().min(0).max(10_000_000).default(0);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const signature = z.string().trim().min(2, "Type your full name to sign");

const address = {
  address: z.string().trim().min(3),
  apt: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().length(2, "Use the 2-letter state code"),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code"),
};

export const w4Schema = z
  .object({
    firstName: z.string().trim().min(1),
    middleInitial: z.string().trim().max(1).optional(),
    lastName: z.string().trim().min(1),
    ...address,
    ssn: ssnSchema,
    /** Step 1(c) */
    filingStatus: z.enum(["single", "married_jointly", "head_of_household"]),
    /** Step 2(c): two jobs total, or married filing jointly and spouse works */
    multipleJobs: z.boolean().default(false),
    /** Step 3 (dollar amounts) */
    childrenAmount: money,
    otherDependentsAmount: money,
    /** Step 4 */
    otherIncome: money,
    deductions: money,
    extraWithholding: money,
    /** Writes "Exempt" below Step 4(c); only if they had no tax liability last year and expect none this year. */
    exempt: z.boolean().default(false),
    signedName: signature,
  })
  .refine((f) => !f.exempt || (f.extraWithholding === 0 && !f.multipleJobs), {
    message: "If you claim exemption, leave Steps 2 and 4(c) empty",
    path: ["exempt"],
  });
export type W4 = z.infer<typeof w4Schema>;

export const CITIZENSHIP = ["citizen", "noncitizen_national", "permanent_resident", "authorized_alien"] as const;

export const i9Section1Schema = z
  .object({
    lastName: z.string().trim().min(1),
    firstName: z.string().trim().min(1),
    middleInitial: z.string().trim().max(1).optional(),
    otherLastNames: z.string().trim().optional(),
    ...address,
    dateOfBirth: isoDate,
    /** Optional on Form I-9 unless the employer uses E-Verify. */
    ssn: z.union([ssnSchema, z.literal("")]).optional(),
    email: z.string().trim().email().optional().or(z.literal("")),
    phone: z.string().trim().optional(),
    citizenship: z.enum(CITIZENSHIP),
    /** Lawful permanent resident: USCIS A-Number. Authorized alien: one of the three below. */
    uscisNumber: z.string().trim().optional(),
    i94Number: z.string().trim().optional(),
    foreignPassportNumber: z.string().trim().optional(),
    passportCountry: z.string().trim().optional(),
    /** Authorized alien: when work authorization expires, or "N/A". */
    workAuthExpires: z.string().trim().optional(),
    /** Someone helped fill it out: needs Supplement A (on paper, for now). */
    usedPreparer: z.boolean().default(false),
    signedName: signature,
  })
  .refine((f) => f.citizenship !== "permanent_resident" || !!f.uscisNumber, {
    message: "Enter your USCIS number (A-Number)",
    path: ["uscisNumber"],
  })
  .refine(
    (f) =>
      f.citizenship !== "authorized_alien" ||
      (!!f.workAuthExpires && (!!f.uscisNumber || !!f.i94Number || (!!f.foreignPassportNumber && !!f.passportCountry))),
    { message: "Enter your work authorization expiration (or N/A) and a USCIS number, I-94 number, or foreign passport number and country", path: ["citizenship"] },
  );
export type I9Section1 = z.infer<typeof i9Section1Schema>;

const i9Document = z.object({
  title: z.string().trim().min(1),
  issuingAuthority: z.string().trim().min(1),
  number: z.string().trim().min(1),
  expires: z.string().trim().optional(),
});

export const i9Section2Schema = z
  .object({
    firstDayOfEmployment: isoDate,
    /** Either one List A document (up to three for some combinations)… */
    listA: z.array(i9Document).max(3).default([]),
    /** …or one List B plus one List C document. */
    listB: i9Document.optional(),
    listC: i9Document.optional(),
    additionalInfo: z.string().trim().optional(),
    /** Examined documents through a DHS-authorized alternative procedure (E-Verify employers only). */
    alternativeProcedure: z.boolean().default(false),
    employerTitle: z.string().trim().min(1),
    signedName: signature,
  })
  .refine((f) => f.listA.length > 0 || (!!f.listB && !!f.listC), {
    message: "Record either a List A document, or one List B and one List C document",
    path: ["listA"],
  });
export type I9Section2 = z.infer<typeof i9Section2Schema>;

export const directDepositSchema = z
  .object({
    bankName: z.string().trim().min(1),
    routingNumber: z.string().trim().refine(isValidRoutingNumber, "That isn't a valid 9-digit routing number"),
    accountNumber: z.string().trim().regex(/^\d{4,17}$/, "Account numbers are 4–17 digits"),
    accountNumberConfirm: z.string().trim(),
    accountType: z.enum(["checking", "savings"]),
    signedName: signature,
  })
  .refine((f) => f.accountNumber === f.accountNumberConfirm, { message: "The account numbers don't match", path: ["accountNumberConfirm"] });
export type DirectDeposit = z.infer<typeof directDepositSchema>;

export const companyPayrollInfoSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  ein: z
    .string()
    .trim()
    .regex(/^\d{2}-?\d{7}$/, "EIN looks like 12-3456789")
    .transform((s) => s.replace(/^(\d{2})-?(\d{7})$/, "$1-$2"))
    .optional()
    .or(z.literal("")),
  address: z.string().trim().max(300).optional(),
});
