import { z } from "zod";
import { htmlToText } from "./templates";

/**
 * Resources → Documents, like Homeworks: letters, contracts and proposals written once (from a
 * document template or from scratch) with fill-ins such as {{CUSTOMER_NAME}}, then emailed or
 * printed for the customers you pick, one letter each on the company's letterhead.
 */

/** Homeworks' "Insert Customer / Company Info" list, in its order and wording. */
export const DOC_TAGS: { label: string; tag: string }[] = [
  { label: "COMPANY NAME", tag: "COMPANY_NAME" },
  { label: "COMPANY ADDRESS", tag: "COMPANY_ADDRESS" },
  { label: "COMPANY EMAIL", tag: "COMPANY_EMAIL" },
  { label: "COMPANY PHONE", tag: "COMPANY_PHONE" },
  { label: "COMPANY WEBSITE", tag: "COMPANY_WEBSITE" },
  { label: "COMPANY OWNER FIRST NAME", tag: "COMPANY_OWNER_FIRST_NAME" },
  { label: "COMPANY OWNER LAST NAME", tag: "COMPANY_OWNER_LAST_NAME" },
  { label: "CUSTOMER NAME", tag: "CUSTOMER_NAME" },
  { label: "CUSTOMER FIRST NAME", tag: "CUSTOMER_FIRST_NAME" },
  { label: "CUSTOMER LAST NAME", tag: "CUSTOMER_LAST_NAME" },
  { label: "CUSTOMER COMPANY NAME", tag: "CUSTOMER_COMPANY_NAME" },
  { label: "CUSTOMER PHONE", tag: "CUSTOMER_PHONE" },
  { label: "CUSTOMER CELL", tag: "CUSTOMER_CELL" },
  { label: "CUSTOMER ACCOUNT BALANCE", tag: "CUSTOMER_ACCOUNT_BALANCE" },
  { label: "CUSTOMER ADDRESS", tag: "CUSTOMER_ADDRESS" },
  { label: "CUSTOMER CITY", tag: "CUSTOMER_CITY" },
  { label: "CUSTOMER STATE", tag: "CUSTOMER_STATE" },
  { label: "CUSTOMER ZIP", tag: "CUSTOMER_ZIP" },
  { label: "CUSTOMER PORTAL LINK", tag: "CLIENT_PORTAL_LINK" },
  { label: "CUSTOMER PORTAL ADD CREDIT CARD LINK", tag: "CLIENT_PORTAL_ADD_CREDIT_CARD_LINK" },
  { label: "REVIEW PAGE", tag: "REVIEW_PAGE" },
  { label: "TODAY", tag: "TODAY" },
  { label: "CURRENT MONTH", tag: "CURRENT_MONTH" },
  { label: "CURRENT YEAR", tag: "CURRENT_YEAR" },
];

export const DOC_NAME_MAX = 100;
export const DOC_CONTENT_MAX = 200_000;
/** The most customers picked one by one in the pop-ups (a list from the Customers page can be bigger). */
export const DOC_CUSTOMERS_MAX = 200;
/** The most letters in one PDF. */
export const DOC_PRINT_MAX = 2000;

/** Words in a document, as the editor counts them. */
export const docWords = (html: string) => { const t = htmlToText(html).trim(); return t ? t.split(/\s+/).length : 0; };

const content = z.string().max(DOC_CONTENT_MAX, "That's too long for one document").refine((v) => !!htmlToText(v).trim(), "Please enter the content");
const name = z.string().trim().min(1, "Please enter the name").max(DOC_NAME_MAX, `Keep the name under ${DOC_NAME_MAX} characters`);

/** A document, and a document template: a name and the words. */
export const docSchema = z.object({ name, content });
export type DocInput = z.infer<typeof docSchema>;

/** The customers picked one by one in the Send Email and Print pop-ups. */
export const docCustomersSchema = z.object({
  customerIds: z.array(z.string().uuid(), { required_error: "Please select at least one customer" }).min(1, "Please select at least one customer").max(DOC_CUSTOMERS_MAX, `Pick up to ${DOC_CUSTOMERS_MAX} customers at a time`),
});
const emailTemplateId = z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable()).default(null);
/** Email a document: as the email itself, or with an email template and the document attached as a PDF. */
export const docEmailSchema = z.object({
  emailTemplateId,
  attachPdf: z.boolean().default(false),
  /** Who it went to, in words, when it's sent to a list from the Customers page. */
  audience: z.string().trim().max(300).optional(),
});
/** Print letters: for everyone picked, or only those an email can't reach. `preview` leaves no history. */
export const docPrintSchema = z.object({ only: z.enum(["all", "notEmailed"]).default("all"), preview: z.boolean().default(false) });
/** Before sending: the document as one customer will get it. */
export const docPreviewSchema = z.object({ customerId: z.string().uuid(), emailTemplateId });

export const DOC_HISTORY_ACTIONS = ["created", "updated", "emailed", "printed"] as const;
export type DocHistoryAction = (typeof DOC_HISTORY_ACTIONS)[number];
export type DocHistoryDetail = {
  /** Printed or emailed: how many customers. */
  customers?: number;
  /** Emailed: how it went. */
  sent?: number; failed?: number; skipped?: number; done?: boolean; stopped?: boolean; emailTemplate?: string | null; attachPdf?: boolean; error?: string | null;
  /** Emailed: the message in Customers → Sent messages, with everyone on it. */
  messageId?: string;
};

/** One line of a document's history, in Homeworks' words ("Created by John Test on …"). */
export function docHistoryText(action: DocHistoryAction, d: DocHistoryDetail | null | undefined): { verb: string; rest: string } {
  const n = (c: number | undefined) => `${c ?? 0} customer${(c ?? 0) === 1 ? "" : "s"}`;
  if (action === "printed") return { verb: "Printed", rest: ` for ${n(d?.customers)}` };
  if (action === "emailed") {
    const bits = [
      d?.done ? `to ${n(d.sent)}` : `to ${n(d?.customers)} (${d?.sent ?? 0} sent so far)`,
      d?.failed ? `${d.failed} failed${d.error ? `: ${d.error}` : ""}` : "",
      d?.skipped ? `${d.skipped} skipped` : "",
      d?.stopped ? "stopped early" : "",
    ].filter(Boolean);
    return { verb: "Emailed", rest: ` ${bits.join(", ")}` };
  }
  return { verb: action === "created" ? "Created" : "Updated", rest: "" };
}

/** Homeworks' document templates, as Crewdesk's import file has them. */
export const docImportSchema = z.object({
  source: z.string().max(40).default("homeworks"),
  documentTemplates: z.array(z.object({
    name: z.string().trim().min(1).max(DOC_NAME_MAX),
    content: z.string().max(DOC_CONTENT_MAX),
    homeworksId: z.union([z.number(), z.string()]).optional(),
  })).min(1, "The file has no document templates").max(500),
});
export type DocImport = z.infer<typeof docImportSchema>;
