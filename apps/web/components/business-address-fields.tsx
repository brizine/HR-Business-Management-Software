"use client";

type Address = { addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; zip?: string | null };

/** The business address, one box each (Settings → Company info and Payroll settings edit the same address). */
export function BusinessAddressFields({ initial }: { initial: Address }) {
  return (
    <fieldset className="formgrid contact-fieldset">
      <legend>Business address</legend>
      <label style={{ gridColumn: "span 2" }}>Street address<input name="addressLine1" maxLength={200} defaultValue={initial.addressLine1 ?? ""} autoComplete="address-line1" /></label>
      <label>Suite, unit, floor<input name="addressLine2" maxLength={200} defaultValue={initial.addressLine2 ?? ""} autoComplete="address-line2" /></label>
      <label>City<input name="city" maxLength={100} defaultValue={initial.city ?? ""} autoComplete="address-level2" /></label>
      <label>State<input name="state" maxLength={2} defaultValue={initial.state ?? ""} placeholder="TX" autoComplete="address-level1" style={{ textTransform: "uppercase" }} /></label>
      <label>ZIP<input name="zip" maxLength={10} inputMode="numeric" defaultValue={initial.zip ?? ""} autoComplete="postal-code" /></label>
    </fieldset>
  );
}

/** The address boxes from a form, as the API expects them (an empty box clears it). */
export const businessAddressValues = (get: (name: string) => string) => ({
  addressLine1: get("addressLine1"),
  addressLine2: get("addressLine2"),
  city: get("city"),
  state: get("state"),
  zip: get("zip"),
});
