import type { bigcapital } from "./bigcapital";

/**
 * Sets up a test Bigcapital organization to match ProSpray's real books, so the test company's
 * invoices and payments land in accounts with the same codes and names. Only offered in the test
 * company. Safe to run again: accounts already set up are left alone.
 *
 * Bigcapital seeds every new organization with the same starter accounts (ids 1000–1033). Those
 * are renamed or made inactive, after checking each one's type, and the rest are created.
 */

type Client = ReturnType<typeof bigcapital>;

/** Starter account id → [code, name, description]. */
const RENAME: Record<number, [string, string, string | null]> = {
  1000: ["1000", "Business Checking", "Main operating account (test books)"],
  1001: ["1010", "Savings / Tax Reserve", "Payroll and sales tax money, plus each owner's share set aside for personal income tax"],
  1002: ["1020", "Undeposited Funds", "Customer checks and cash not yet deposited"],
  1003: ["1040", "Petty Cash", null],
  1006: ["1200", "Accounts Receivable", "Needed for invoices"],
  1030: ["1300", "Prepaid Expenses", null],
  1008: ["2000", "Accounts Payable", "Needed for bills"],
  1013: ["2200", "Sales Tax Payable – OK", "Only for taxable product sales"],
  1029: ["2400", "Customer Prepayments", "Season or annual programs paid up front (customer advance deposit account)"],
  1016: ["3000", "Capital Contributions – Brian Henderson", null],
  1017: ["3100", "Shareholder Distributions – Brian Henderson", null],
  1015: ["3200", "Opening Balance Equity", null],
  1014: ["3900", "Retained Earnings", null],
  1026: ["4000", "Lawn Treatment Programs", "Recurring fertilizer and weed control rounds"],
  1025: ["4300", "Product Sales", "Retail products sold separately (taxable)"],
  1031: ["4900", "Discounts and Refunds", "Prepay discounts, credits, refunds"],
  1028: ["4950", "Other Income", null],
  1033: ["4960", "Other Charges", null],
  1027: ["4990", "Uncategorized Income", null],
  1019: ["5300", "Products for Resale", null],
  1020: ["6700", "Office Supplies and Postage", null],
  1021: ["6710", "Rent and Shop Utilities", null],
  1023: ["6810", "Bank and Merchant Fees", "Card processing fees, bank charges"],
  1024: ["7000", "Depreciation", null],
  1018: ["7100", "Interest Expense", null],
  1032: ["7150", "Purchase Discounts", null],
};

/** Starter accounts ProSpray doesn't use (made inactive, never deleted); products too, since ProSpray sells services only. */
const INACTIVATE = [1004, 1005, 1007, 1009, 1010, 1011, 1012, 1022, 1013, 1025, 1019];

/** [code, name, type, parent code]. */
const NEW: [string, string, string, string | null][] = [
  ["1030", "Card Processor Clearing", "cash", null],
  ["1500", "Trucks and Trailers", "fixed-asset", null],
  ["1510", "Spray Equipment", "fixed-asset", null],
  ["1520", "Mowers and Power Equipment", "fixed-asset", null],
  ["1590", "Accumulated Depreciation", "fixed-asset", null],
  ["2100", "Business Credit Card", "credit-card", null],
  ["2300", "Payroll Liabilities", "other-current-liability", null],
  ["2310", "Federal Withholding and FICA Payable", "other-current-liability", "2300"],
  ["2320", "Oklahoma Withholding Payable", "other-current-liability", "2300"],
  ["2330", "Oklahoma Unemployment (OESC) Payable", "other-current-liability", "2300"],
  ["2700", "Truck Loan", "long-term-liability", null],
  ["3010", "Capital Contributions – Jarrett Henderson", "equity", null],
  ["3110", "Shareholder Distributions – Jarrett Henderson", "equity", null],
  ["4100", "Pest Control Services", "income", null],
  ["4200", "One-Time Lawn Services", "income", null],
  ["5000", "Fertilizer and Herbicides", "cost-of-goods-sold", null],
  ["5100", "Insecticides and Pest Products", "cost-of-goods-sold", null],
  ["5200", "Seed and Soil Amendments", "cost-of-goods-sold", null],
  ["5400", "Field Labor – Wages", "cost-of-goods-sold", null],
  ["5410", "Field Labor – Payroll Taxes", "cost-of-goods-sold", null],
  ["5500", "Subcontractors", "cost-of-goods-sold", null],
  ["5600", "Disposal and Dump Fees", "cost-of-goods-sold", null],
  ["6000", "Vehicle Fuel", "expense", null],
  ["6010", "Vehicle Repairs and Maintenance", "expense", null],
  ["6020", "Vehicle Registration and Tags", "expense", null],
  ["6100", "Equipment Repairs and Parts", "expense", null],
  ["6110", "Small Tools and Equipment", "expense", null],
  ["6200", "Insurance – General Liability", "expense", null],
  ["6210", "Insurance – Commercial Auto", "expense", null],
  ["6220", "Insurance – Workers' Comp", "expense", null],
  ["6300", "Licenses and Permits", "expense", null],
  ["6310", "Training and Certification CEUs", "expense", null],
  ["6400", "Uniforms and Safety Gear (PPE)", "expense", null],
  ["6500", "Advertising and Marketing", "expense", null],
  ["6600", "Software and Subscriptions", "expense", null],
  ["6610", "Phone and Internet", "expense", null],
  ["6800", "Professional Fees", "expense", null],
  ["6900", "Office Wages", "expense", null],
  ["6910", "Employee Benefits", "expense", null],
  ["6920", "Officer Wages (owners)", "expense", null],
  ["6921", "Officer Payroll Taxes", "expense", null],
  ["6930", "Owners' Health Insurance", "expense", null],
  ["6950", "Meals (50%)", "expense", null],
  ["6960", "Travel", "expense", null],
  ["7200", "Uncategorized Expense", "expense", null],
];

const typeOf = (a: any): string => String(a.account_type ?? a.accountType ?? "");
const isActive = (a: any) => a.active !== false && a.active !== 0;

export interface TestBooksResult { renamed: number; inactivated: number; created: number; skipped: string[] }

export async function setUpTestBooks(bc: Client): Promise<TestBooksResult> {
  const result: TestBooksResult = { renamed: 0, inactivated: 0, created: 0, skipped: [] };
  let all = await bc.allAccountsRaw();
  const byId = () => new Map(all.map((a) => [Number(a.id), a]));
  const byCode = () => new Map(all.filter((a) => a.code).map((a) => [String(a.code), a]));

  // Codes must be unique, so rename the starters first (the codes they get are the ones the new accounts don't use).
  for (const [idStr, [code, name, description]] of Object.entries(RENAME)) {
    const a = byId().get(Number(idStr));
    if (!a) { result.skipped.push(`starter account ${idStr} not found`); continue; }
    if (a.code === code && a.name === name) continue;
    const holder = byCode().get(code);
    if (holder && Number(holder.id) !== Number(idStr)) { result.skipped.push(`${code} is already used by "${holder.name}"`); continue; }
    await bc.updateAccount(Number(idStr), { name, code, accountType: typeOf(a), description, parentAccountId: a.parent_account_id ?? null });
    result.renamed++;
  }
  all = await bc.allAccountsRaw();
  for (const id of INACTIVATE) {
    const a = byId().get(id);
    if (!a || !isActive(a)) continue;
    await bc.inactivateAccount(id);
    result.inactivated++;
  }
  for (const [code, name, accountType, parent] of NEW) {
    const codes = byCode();
    if (codes.has(code)) continue;
    const parentId = parent ? Number(codes.get(parent)?.id) : null;
    if (parent && !parentId) { result.skipped.push(`${code} ${name}: parent ${parent} missing`); continue; }
    await bc.createAccount({ name, code, accountType, parentAccountId: parentId });
    result.created++;
    all = await bc.allAccountsRaw();
  }

  // The same preferences as the real books: cash basis, codes required and unique, where payments go, no sales tax.
  const codes = byCode();
  const id = (code: string) => (codes.get(code) ? Number(codes.get(code).id) : null);
  const options: { group: string; key: string; value: unknown }[] = [
    { group: "organization", key: "accounting_basis", value: "cash" },
    { group: "accounts", key: "account_code_required", value: true },
    { group: "accounts", key: "account_code_unique", value: true },
    { group: "features", key: "sales_tax", value: false },
    { group: "features", key: "landed_cost", value: false },
    { group: "features", key: "batch_tracking", value: false },
    { group: "features", key: "recurring_journals", value: false },
    { group: "features", key: "sms_notifications", value: false },
  ];
  if (id("1020")) options.push({ group: "payment_receives", key: "preferred_deposit_account", value: id("1020") });
  if (id("2400")) options.push({ group: "payment_receives", key: "preferred_advance_deposit", value: id("2400") });
  if (id("1000")) options.push({ group: "bill_payments", key: "withdrawal_account", value: id("1000") });
  await bc.saveSettings(options);
  return result;
}
