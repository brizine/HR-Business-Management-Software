/**
 * US phone numbers are shown and saved as (555) 555-5555. Numbers that aren't 10-digit US numbers
 * (international "+44 …", extensions) are left as typed.
 */

/** The 10 digits of a US number (a leading 1 / +1 dropped), or null if it isn't one. */
function usDigits(value: string): string | null {
  const v = value.trim();
  if (v.startsWith("+") && !v.startsWith("+1")) return null;
  let d = v.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** For saving and showing: "5125550100" → "(512) 555-0100"; anything else is returned trimmed. */
export function normalizePhone(value: string): string;
export function normalizePhone(value: string | null | undefined): string | null | undefined;
export function normalizePhone(value: string | null | undefined) {
  if (value == null) return value;
  const d = usDigits(value);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : value.trim();
}

/** For showing a saved number (older ones may not be formatted yet). */
export const formatPhone = (value: string | null | undefined) => (value ? normalizePhone(value) : "");

/**
 * As someone types: "512" → "(512", "51255" → "(512) 55", "5125550100" → "(512) 555-0100".
 * International numbers (starting with + but not +1) and longer entries are left alone.
 */
export function formatPhoneTyping(value: string): string {
  const v = value.trimStart();
  if (v.startsWith("+") && !v.startsWith("+1")) return value;
  let d = v.replace(/\D/g, "");
  // US area codes never start with 1, so a leading 1 is the country code.
  if (d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) return value;
  if (!d) return v.startsWith("+") ? value : "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
