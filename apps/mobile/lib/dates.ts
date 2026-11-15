/** Formats what's typed into a date box as MM-DD-YYYY, adding the dashes automatically. */
export function formatMdyTyping(text: string) {
  const d = text.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

/** "12-22-2026" → "2026-12-22" (what the server stores), or null if it isn't a real date. */
export function mdyToIso(mdy: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mdy.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null;
  return `${yyyy}-${mm}-${dd}`;
}
