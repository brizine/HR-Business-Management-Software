/**
 * A small client for Bigcapital's REST API (https://github.com/bigcapitalhq/bigcapital).
 *
 * - Auth: an API key made in Bigcapital (Preferences → API keys), sent as `Authorization: Bearer
 *   bc_…`. The key belongs to one organization, so no organization header is needed.
 * - Requests are camelCase. Bigcapital converts top-level response keys to snake_case but leaves
 *   objects inside arrays as they are, so responses are read in either form.
 * - Amounts are in the organization's currency units (dollars, not cents).
 */
export class BigcapitalError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface BigcapitalAccount { id: number; name: string; code: string | null; type: string; active: boolean }

const pick = <T>(o: any, ...keys: string[]): T | undefined => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};
const dollars = (cents: number) => Math.round(cents) / 100;

export function bigcapital(baseUrl: string, apiKey: string, timeoutMs = 15_000) {
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BigcapitalError(`Couldn't reach Bigcapital at ${baseUrl} (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`);
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const errs = (data?.errors ?? []) as { type?: string; message?: string }[];
      const detail = errs.map((e) => e.message || e.type).filter(Boolean).join("; ") || data?.message || text.slice(0, 200) || res.statusText;
      if (res.status === 401 || res.status === 403) throw new BigcapitalError(`Bigcapital refused the API key (${detail}). Make a new key in Bigcapital under Preferences → API keys.`, res.status);
      throw new BigcapitalError(`Bigcapital said: ${detail}`, res.status);
    }
    return data;
  }
  /** The created record's id, wherever Bigcapital put it in the response. */
  const idOf = (data: any): string | null => {
    const id = pick<number | string>(data, "id") ?? pick<any>(data, "data")?.id ?? pick<any>(data, "manual_journal", "manualJournal", "expense")?.id;
    return id == null ? null : String(id);
  };

  return {
    async accounts(): Promise<BigcapitalAccount[]> {
      const data = await call("GET", "/accounts");
      const list: any[] = Array.isArray(data) ? data : data?.accounts ?? [];
      return list.map((a) => ({
        id: Number(a.id),
        name: String(a.name ?? ""),
        code: (pick<string>(a, "code") ?? null) || null,
        type: String(pick<string>(a, "accountType", "account_type") ?? ""),
        active: pick<boolean>(a, "active") !== false,
      }));
    },

    /** A published manual journal entry (debits must equal credits). */
    async createJournal(j: { date: string; reference: string; description: string; lines: { accountId: number; debitCents?: number; creditCents?: number; note?: string }[] }) {
      const debit = j.lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
      const credit = j.lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
      if (debit !== credit || !debit) throw new BigcapitalError("The journal entry doesn't balance");
      const data = await call("POST", "/manual-journals", {
        date: j.date,
        reference: j.reference.slice(0, 255),
        description: j.description,
        publish: true,
        entries: j.lines.map((l, i) => ({
          index: i + 1,
          accountId: l.accountId,
          ...(l.debitCents ? { debit: dollars(l.debitCents) } : {}),
          ...(l.creditCents ? { credit: dollars(l.creditCents) } : {}),
          ...(l.note ? { note: l.note } : {}),
        })),
      });
      return idOf(data);
    },

    /** A published expense paid from `paymentAccountId`. */
    async createExpense(e: { paymentDate: string; referenceNo: string; description: string; paymentAccountId: number; categories: { accountId: number; amountCents: number; description: string }[] }) {
      const data = await call("POST", "/expenses", {
        paymentDate: e.paymentDate,
        referenceNo: e.referenceNo,
        description: e.description,
        paymentAccountId: e.paymentAccountId,
        publish: true,
        categories: e.categories.filter((c) => c.amountCents > 0).map((c, i) => ({ index: i + 1, expenseAccountId: c.accountId, amount: dollars(c.amountCents), description: c.description })),
      });
      return idOf(data);
    },
  };
}
