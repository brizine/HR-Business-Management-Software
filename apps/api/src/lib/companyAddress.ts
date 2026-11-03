import { COMPANY_ADDRESS_FIELDS, formatCompanyAddress, type CompanyAddress } from "@crewdesk/shared";

type Body = Record<string, unknown>;

/**
 * Database changes for the business address boxes in a request body (Company info or Payroll settings).
 * Boxes left out of the body keep their saved value; an empty box clears it. The whole address is
 * also stored on one line (companies.address), which tax forms print.
 */
export function companyAddressUpdate(body: Body, current: CompanyAddress) {
  if (!COMPANY_ADDRESS_FIELDS.some((k) => k in body)) return {};
  const next = Object.fromEntries(
    COMPANY_ADDRESS_FIELDS.map((k) => [k, k in body ? ((body[k] as string | undefined)?.trim() || null) : (current[k] ?? null)]),
  ) as Record<(typeof COMPANY_ADDRESS_FIELDS)[number], string | null>;
  return { ...next, address: formatCompanyAddress(next) || null };
}

/** The body without the address boxes (for spreading the rest into a database update). */
export function withoutAddress<T extends Body>(body: T) {
  const rest: Body = { ...body };
  for (const k of COMPANY_ADDRESS_FIELDS) delete rest[k];
  return rest as Omit<T, (typeof COMPANY_ADDRESS_FIELDS)[number]>;
}

/** The address boxes, for API responses. */
export const companyAddressView = (c: CompanyAddress & { address: string | null }) => ({
  address: c.address,
  addressLine1: c.addressLine1 ?? null,
  addressLine2: c.addressLine2 ?? null,
  city: c.city ?? null,
  state: c.state ?? null,
  zip: c.zip ?? null,
});
