"use client";
import { EMPLOYEE_PRIVATE_CONTACT_FIELDS } from "@crewdesk/shared";
import { today } from "@/lib/api";

/** Date of birth, home address and emergency contact inputs, shared by the employee form and Settings → My info. */
export function ContactFields({ initial = {} as any }) {
  return (
    <>
      <div className="formgrid" style={{ marginTop: 14 }}>
        <label>Date of birth<input name="dateOfBirth" type="date" min="1900-01-01" max={today()} defaultValue={initial.dateOfBirth ?? ""} autoComplete="bday" /></label>
      </div>
      <fieldset className="formgrid contact-fieldset">
        <legend>Home address</legend>
        <label style={{ gridColumn: "span 2" }}>Street address<input name="addressLine1" defaultValue={initial.addressLine1 ?? ""} autoComplete="address-line1" /></label>
        <label>Apt, suite, unit<input name="addressLine2" defaultValue={initial.addressLine2 ?? ""} autoComplete="address-line2" /></label>
        <label>City<input name="city" defaultValue={initial.city ?? ""} autoComplete="address-level2" /></label>
        <label>State<input name="state" defaultValue={initial.state ?? ""} maxLength={2} placeholder="TX" autoComplete="address-level1" style={{ textTransform: "uppercase" }} /></label>
        <label>ZIP<input name="zip" defaultValue={initial.zip ?? ""} inputMode="numeric" maxLength={10} autoComplete="postal-code" /></label>
      </fieldset>
      <fieldset className="formgrid contact-fieldset">
        <legend>Emergency contact</legend>
        <label>Name<input name="emergencyName" defaultValue={initial.emergencyName ?? ""} /></label>
        <label>Relationship<input name="emergencyRelationship" defaultValue={initial.emergencyRelationship ?? ""} placeholder="e.g. Spouse, parent" /></label>
        <label>Phone<input name="emergencyPhone" type="tel" defaultValue={initial.emergencyPhone ?? ""} /></label>
      </fieldset>
    </>
  );
}

/** Empty boxes are left out of form values; send them as null so clearing a field clears it. */
export function withClearedContact(v: Record<string, any>) {
  for (const f of EMPLOYEE_PRIVATE_CONTACT_FIELDS) v[f] = v[f] ?? null;
  return v;
}
