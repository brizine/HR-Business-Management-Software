/** Test books: a fresh Bigcapital organization ends up with the same chart of accounts as ProSpray's real books. */
import { describe, expect, it } from "vitest";
import { setUpTestBooks } from "../src/lib/testBooks";

const STARTER_TYPES: Record<number, string> = {
  1000: "bank", 1001: "bank", 1002: "cash", 1003: "cash", 1004: "fixed-asset", 1005: "fixed-asset", 1006: "accounts-receivable", 1007: "inventory",
  1008: "accounts-payable", 1009: "other-current-liability", 1010: "other-current-liability", 1011: "other-current-liability", 1012: "other-current-liability",
  1013: "tax-payable", 1014: "equity", 1015: "equity", 1016: "equity", 1017: "equity", 1018: "other-expense", 1019: "cost-of-goods-sold", 1020: "expense",
  1021: "expense", 1022: "other-expense", 1023: "expense", 1024: "expense", 1025: "income", 1026: "income", 1027: "income", 1028: "other-income",
  1029: "other-current-liability", 1030: "other-current-asset", 1031: "other-income", 1032: "other-expense", 1033: "other-income",
};
// The real books (Nov 2026): active and inactive account codes.
const REAL_ACTIVE = ["1000", "1010", "1020", "1030", "1040", "1200", "1300", "1500", "1510", "1520", "1590", "2000", "2100", "2300", "2310", "2320", "2330", "2400", "2700", "3000", "3010", "3100", "3110", "3200", "3900", "4000", "4100", "4200", "4900", "4950", "4960", "4990", "5000", "5100", "5200", "5400", "5410", "5500", "5600", "6000", "6010", "6020", "6100", "6110", "6200", "6210", "6220", "6300", "6310", "6400", "6500", "6600", "6610", "6700", "6710", "6800", "6810", "6900", "6910", "6920", "6921", "6930", "6950", "6960", "7000", "7100", "7150", "7200"];
const REAL_INACTIVE = ["10005", "10006", "10008", "20002", "20003", "20004", "20005", "2200", "40005", "4300", "5300"];

/** A fake Bigcapital holding a freshly seeded organization. */
function fakeBooks() {
  let next = 1034;
  const accounts = Object.entries(STARTER_TYPES).map(([id, t]) => ({ id: Number(id), code: "", name: `Starter ${id}`, account_type: t, active: true, parent_account_id: null as number | null }));
  // Match Bigcapital's 5-digit starter codes (10001…, 20001…, 40001…), which never clash with ProSpray's 4-digit codes.
  const starterCode: Record<number, string> = { 1004: "10005", 1005: "10006", 1007: "10008", 1009: "20002", 1010: "20003", 1011: "20004", 1012: "20005", 1022: "40005" };
  for (const a of accounts) a.code = starterCode[a.id] ?? `9${a.id}`;
  const settings: { group: string; key: string; value: unknown }[] = [];
  const client = {
    allAccountsRaw: async () => accounts.map((a) => ({ ...a })),
    updateAccount: async (id: number, b: { name: string; code: string; accountType: string }) => {
      const a = accounts.find((x) => x.id === id)!;
      if (b.accountType !== a.account_type) throw new Error("type changed");
      if (accounts.some((x) => x.code === b.code && x.id !== id)) throw new Error("code taken");
      Object.assign(a, { name: b.name, code: b.code });
    },
    createAccount: async (b: { name: string; code: string; accountType: string; parentAccountId?: number | null }) => {
      if (accounts.some((x) => x.code === b.code)) throw new Error("code taken");
      accounts.push({ id: next++, code: b.code, name: b.name, account_type: b.accountType, active: true, parent_account_id: b.parentAccountId ?? null });
      return String(next - 1);
    },
    inactivateAccount: async (id: number) => { accounts.find((x) => x.id === id)!.active = false; },
    saveSettings: async (o: { group: string; key: string; value: unknown }[]) => { settings.push(...o); },
  };
  return { client, accounts, settings };
}

describe("test books", () => {
  it("matches the real chart of accounts and preferences, and is safe to run again", async () => {
    const f = fakeBooks();
    const r = await setUpTestBooks(f.client as never);
    expect(r).toMatchObject({ renamed: 26, inactivated: 11, created: 45, skipped: [] });
    expect(f.accounts.filter((a) => a.active).map((a) => a.code).sort()).toEqual(REAL_ACTIVE);
    expect(f.accounts.filter((a) => !a.active).map((a) => a.code).sort()).toEqual(REAL_INACTIVE);
    const byCode = (c: string) => f.accounts.find((a) => a.code === c)!;
    expect(byCode("2310").parent_account_id).toBe(byCode("2300").id);
    expect(byCode("1000").name).toBe("Business Checking");
    expect(f.settings).toEqual(expect.arrayContaining([
      { group: "organization", key: "accounting_basis", value: "cash" },
      { group: "payment_receives", key: "preferred_deposit_account", value: byCode("1020").id },
      { group: "payment_receives", key: "preferred_advance_deposit", value: byCode("2400").id },
      { group: "bill_payments", key: "withdrawal_account", value: byCode("1000").id },
      { group: "features", key: "sales_tax", value: false },
    ]));
    const again = await setUpTestBooks(f.client as never);
    expect(again).toMatchObject({ renamed: 0, inactivated: 0, created: 0, skipped: [] });
  });
});
