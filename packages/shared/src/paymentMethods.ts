/** Cards and bank accounts customers save with Stripe for later payments (and autopay). */
export type SavedMethodView = {
  type: "card" | "ach" | string; brand?: string | null; last4?: string | null; expMonth?: number | null; expYear?: number | null;
  bankName?: string | null; accountType?: string | null;
};

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };

/** "Visa ·· 4242" or "Arvest Bank checking ·· 6789". */
export function paymentMethodLabel(m: SavedMethodView): string {
  if (m.type === "ach") return `${m.bankName ?? "Bank"} ${m.accountType ?? "account"} ·· ${m.last4 ?? "????"}`;
  const brand = m.brand ? BRANDS[m.brand] ?? m.brand[0].toUpperCase() + m.brand.slice(1) : "Card";
  return `${brand} ·· ${m.last4 ?? "????"}`;
}

/** "04/28" for a card's expiry; empty for bank accounts. */
export const cardExpiry = (m: SavedMethodView) => (m.type === "card" && m.expMonth && m.expYear ? `${String(m.expMonth).padStart(2, "0")}/${String(m.expYear).slice(-2)}` : "");

/** A card past its expiry month (on the given YYYY-MM-DD day) can't be charged. */
export function cardExpired(m: SavedMethodView, today: string): boolean {
  if (m.type !== "card" || !m.expMonth || !m.expYear) return false;
  const [y, mo] = today.split("-").map(Number);
  return m.expYear < y || (m.expYear === y && m.expMonth < mo);
}

/** For the Customers list filter "Payment method on file". */
export const PAYMENT_ON_FILE_OPTIONS = [["card", "Card"], ["ach", "Bank account"], ["none", "None"]] as const;
