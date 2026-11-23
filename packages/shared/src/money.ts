/** "$45.00", "$1,250.50" (no cents shown as .00). Kept on its own so any module can use it without import cycles. */
export function formatMoney(c: number | null | undefined): string {
  if (c == null) return "—";
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
