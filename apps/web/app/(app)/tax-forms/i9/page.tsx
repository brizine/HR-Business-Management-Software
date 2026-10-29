"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ATTESTATIONS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { AddressFields, Section, SignatureBlock, readForm } from "@/components/tax-form-bits";

export default function I9Form() {
  const { me } = useAuth();
  const router = useRouter();
  const prefill = useApi("/tax-forms/prefill/i9");
  const [status, setStatus] = useState<string>("citizen");
  const { busy, error, run } = useAction();
  if (prefill.loading || !me) return null;
  const d = prefill.data ?? { firstName: me.user.firstName, lastName: me.user.lastName, email: me.user.email };

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      run(async () => { await api("/tax-forms/i9", { body: readForm(e.currentTarget) }); router.push("/tax-forms?saved=i9"); });
    }}>
      <PageHead title="Form I-9, Section 1: Employment Eligibility Verification"
        sub={<>Every new employee fills this out by their first day. Then, within 3 business days, bring HR original documents from the <a href="https://www.uscis.gov/i-9-central/form-i-9-acceptable-documents" target="_blank" rel="noreferrer">Lists of Acceptable Documents</a> (for example a U.S. passport, or a driver&apos;s license plus a Social Security card). You choose which documents to show.</>} />
      <Section title="Your information">
        <div className="formgrid">
          <label>Last name (family name)<input name="lastName" defaultValue={d.lastName} required /></label>
          <label>First name (given name)<input name="firstName" defaultValue={d.firstName} required /></label>
          <label>Middle initial<input name="middleInitial" defaultValue={d.middleInitial} maxLength={1} /></label>
          <label>Other last names used (if any)<input name="otherLastNames" defaultValue={d.otherLastNames} /></label>
        </div>
        <AddressFields d={d} />
        <div className="formgrid">
          <label>Date of birth<input name="dateOfBirth" type="date" defaultValue={d.dateOfBirth} required /></label>
          <label>Social Security number<input name="ssn" inputMode="numeric" autoComplete="off" placeholder="Optional" /></label>
          <label>Email (optional)<input name="email" type="email" defaultValue={d.email} /></label>
          <label>Phone (optional)<input name="phone" defaultValue={d.phone} /></label>
        </div>
      </Section>
      <Section title="I attest, under penalty of perjury, that I am (check one):">
        {[
          ["citizen", "1. A citizen of the United States"],
          ["noncitizen_national", "2. A noncitizen national of the United States"],
          ["permanent_resident", "3. A lawful permanent resident"],
          ["authorized_alien", "4. A noncitizen (other than 2 and 3 above) authorized to work"],
        ].map(([v, l]) => (
          <label className="check" key={v}><input type="radio" name="citizenship" value={v} checked={status === v} onChange={() => setStatus(v)} /> {l}</label>
        ))}
        {status === "permanent_resident" && (
          <div className="formgrid"><label>USCIS A-Number<input name="uscisNumber" defaultValue={d.uscisNumber} required placeholder="A123456789" /></label></div>
        )}
        {status === "authorized_alien" && (
          <>
            <div className="formgrid">
              <label>Work authorization expires (date, or N/A)<input name="workAuthExpires" defaultValue={d.workAuthExpires} required /></label>
            </div>
            <p className="muted" style={{ margin: 0 }}>Enter one of these:</p>
            <div className="formgrid">
              <label>USCIS A-Number<input name="uscisNumber" defaultValue={d.uscisNumber} /></label>
              <label>Form I-94 admission number<input name="i94Number" defaultValue={d.i94Number} /></label>
              <label>Foreign passport number<input name="foreignPassportNumber" defaultValue={d.foreignPassportNumber} /></label>
              <label>Country of issuance<input name="passportCountry" defaultValue={d.passportCountry} /></label>
            </div>
          </>
        )}
        <label className="check"><input type="checkbox" name="usedPreparer" /> Someone helped me fill this out (preparer or translator). HR will give you Supplement A to complete on paper.</label>
      </Section>
      <SignatureBlock statement={ATTESTATIONS.i9} defaultName={`${me.user.firstName} ${me.user.lastName}`} busy={busy} error={error} />
    </form>
  );
}
