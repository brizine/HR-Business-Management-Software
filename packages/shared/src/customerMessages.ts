import { z } from "zod";

/**
 * Emails to many customers at once (from the Customers list's Send menu): a subject and message
 * with fill-in fields like {first_name} and {balance}, sent one by one in the background.
 */

/** Fill-in fields, as typed in the message: {first_name}. */
export const MESSAGE_FIELDS = [
  ["first_name", "First name", "Their first name (or the company name for a business)"],
  ["last_name", "Last name", ""],
  ["name", "Full name", "Their full name, or the company name"],
  ["customer_number", "Customer #", ""],
  ["balance", "Balance owed", "e.g. $120.00 ($0.00 when they owe nothing)"],
  ["next_service", "Next scheduled service", "The date of their next open work order, or \"not scheduled yet\""],
  ["last_service", "Last service", "The date of their last completed work order, or \"none yet\""],
  ["company", "Your company name", ""],
  ["company_phone", "Your phone number", ""],
] as const;
export type MessageField = (typeof MESSAGE_FIELDS)[number][0];
export type MessageVars = Partial<Record<MessageField, string>>;

const FIELD_RE = /\{\s*([a-z_]+)\s*\}/gi;
const known = new Set<string>(MESSAGE_FIELDS.map(([k]) => k));

/** The message with each {field} filled in. Unknown {words} are left as they are. */
export function fillMessage(template: string, vars: MessageVars): string {
  return template.replace(FIELD_RE, (all, name: string) => {
    const k = name.toLowerCase();
    return known.has(k) ? vars[k as MessageField] ?? "" : all;
  });
}

/** {words} in the message that aren't fill-in fields (probably typos), for a warning. */
export function unknownFields(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(FIELD_RE)) if (!known.has(m[1].toLowerCase())) out.add(m[0]);
  return [...out];
}

/** Sample values for the preview when no customer is picked. */
export const SAMPLE_MESSAGE_VARS: MessageVars = {
  first_name: "Jane", last_name: "Example", name: "Jane Example", customer_number: "1001", balance: "$120.00",
  next_service: "Apr 14, 2027", last_service: "Mar 3, 2027", company: "Your company", company_phone: "(405) 555-0100",
};

export const customerEmailSchema = z.object({
  subject: z.string().trim().min(1, "Enter a subject").max(200),
  body: z.string().trim().min(1, "Write the message").max(20000),
});
export type CustomerEmailInput = z.infer<typeof customerEmailSchema>;

/** Why a customer on the list didn't get the email. */
export const MESSAGE_SKIP_REASONS = {
  no_email: "No email address",
  unsubscribed: "Unsubscribed from these emails",
  duplicate: "Same email as another customer on the list (sent once)",
  sample: "Sample customer",
  undeliverable: "Address can't receive mail",
  stopped: "Sending was stopped before it got to them",
} as const;
export type MessageSkipReason = keyof typeof MESSAGE_SKIP_REASONS;

/** Message status, for the list of sent messages. */
export const MESSAGE_STATUS_LABELS = { sending: "Sending", sent: "Sent", stopped: "Stopped" } as const;
