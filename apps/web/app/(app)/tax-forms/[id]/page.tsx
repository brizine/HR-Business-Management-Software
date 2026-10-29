"use client";
import { use, useState } from "react";
import { ATTESTATIONS } from "@crewdesk/shared";
import { api, fmtDate, fmtDateTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { DownloadPdf, FormStatus, Section, readForm, signedLine } from "@/components/tax-form-bits";

const LABELS: Record<string, string> = {
  firstName: "First name", middleInitial: "Middle initial", lastName: "Last name", otherLastNames: "Other last names",
  address: "Address", apt: "Apt.", city: "City", state: "State", zip: "ZIP", ssn: "Social Security number",
  filingStatus: "Filing status", multipleJobs: "Step 2(c) checked", childrenAmount: "Step 3: children ($)",
  otherDependentsAmount: "Step 3: other dependents ($)", otherIncome: "4(a) Other income ($)", deductions: "4(b) Deductions ($)",
  extraWithholding: "4(c) Extra withholding per pay period ($)", exempt: "Claims exemption", dateOfBirth: "Date of birth",
  email: "Email", phone: "Phone", citizenship: "Citizenship / immigration status", uscisNumber: "USCIS A-Number",
  i94Number: "Form I-94 number", foreignPassportNumber: "Foreign passport number", passportCountry: "Passport country",
  workAuthExpires: "Work authorization expires", usedPreparer: "Used a preparer/translator", bankName: "Bank",
  routingNumber: "Routing number", accountNumber: "Account number", accountType: "Account type",
};

const show = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : v == null || v === "" ? "—" : String(v).replace(/_/g, " "));

function DocFields({ prefix, required }: { prefix: string; required?: boolean }) {
  return (
    <div className="formgrid">
      <label>Document title<input name={`${prefix}.title`} required={required} placeholder="e.g. U.S. Passport" /></label>
      <label>Issuing authority<input name={`${prefix}.issuingAuthority`} required={required} /></label>
      <label>Document number<input name={`${prefix}.number`} required={required} /></label>
      <label>Expiration date (or N/A)<input name={`${prefix}.expires`} /></label>
    </div>
  );
}

/** Groups "listA.0.title"-style fields into Section 2's shape. */
function section2Body(form: HTMLFormElement, mode: "A" | "BC") {
  const v = readForm(form);
  const doc = (p: string) => ({ title: v[`${p}.title`], issuingAuthority: v[`${p}.issuingAuthority`], number: v[`${p}.number`], expires: v[`${p}.expires`] });
  return {
    firstDayOfEmployment: v.firstDayOfEmployment,
    listA: mode === "A" ? [doc("listA.0"), ...(v["listA.1.title"] ? [doc("listA.1")] : [])] : [],
    listB: mode === "BC" ? doc("listB") : undefined,
    listC: mode === "BC" ? doc("listC") : undefined,
    additionalInfo: v.additionalInfo,
    alternativeProcedure: v.alternativeProcedure,
    employerTitle: v.employerTitle,
    signedName: v.signedName,
  };
}

function Section2({ formId, startDate, onDone }: { formId: string; startDate?: string; onDone: () => void }) {
  const { me } = useAuth();
  const [mode, setMode] = useState<"A" | "BC">("A");
  const { busy, error, run } = useAction();
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      run(async () => { await api(`/tax-forms/${formId}/i9-section-2`, { body: section2Body(e.currentTarget, mode) }); onDone(); });
    }}>
      <Section title="Section 2: Employer review and verification"
        hint="Examine the employee's original documents in person (photocopies aren't accepted) within 3 business days of their first day. Record either one List A document, or one List B and one List C document.">
        <div className="formgrid">
          <label>Employee&apos;s first day of employment<input name="firstDayOfEmployment" type="date" defaultValue={startDate ?? ""} required /></label>
        </div>
        <div className="row">
          <label className="check"><input type="radio" checked={mode === "A"} onChange={() => setMode("A")} /> List A document (proves identity and work authorization)</label>
          <label className="check"><input type="radio" checked={mode === "BC"} onChange={() => setMode("BC")} /> List B + List C documents</label>
        </div>
        {mode === "A" ? (
          <>
            <DocFields prefix="listA.0" required />
            <details><summary className="muted">Second List A document (only for certain combinations)</summary><DocFields prefix="listA.1" /></details>
          </>
        ) : (
          <>
            <strong>List B (identity)</strong><DocFields prefix="listB" required />
            <strong>List C (work authorization)</strong><DocFields prefix="listC" required />
          </>
        )}
        <label>Additional information<textarea name="additionalInfo" /></label>
        <label className="check"><input type="checkbox" name="alternativeProcedure" /> Used the DHS-authorized alternative procedure (remote document examination; E-Verify employers only)</label>
      </Section>
      <Section title="Certification">
        <p style={{ margin: 0 }}>{ATTESTATIONS.i9Employer}</p>
        <div className="formgrid">
          <label>Your name<input name="signedName" defaultValue={me ? `${me.user.firstName} ${me.user.lastName}` : ""} required /></label>
          <label>Your title<input name="employerTitle" required placeholder="e.g. Owner, Office Manager" /></label>
        </div>
        <label className="check"><input type="checkbox" required /> I agree that typing my name is my electronic signature.</label>
        <ErrorBox error={error} />
        <div><button className="btn primary" disabled={busy}>Sign Section 2</button></div>
      </Section>
    </form>
  );
}

export default function ViewTaxForm({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me, can } = useAuth();
  const { data, error, reload } = useApi(`/tax-forms/${id}`);
  const employee = useApi(data && can("admin") ? `/employees/${data.form.employeeId}` : null);
  if (!data) return <ErrorBox error={error} />;
  const f = data.form;
  const needsSection2 = f.type === "i9" && f.status !== "completed" && !f.supersededAt && can("admin") && f.employeeId !== me?.user.id;

  return (
    <>
      <PageHead title={f.label} sub={`${employee.data ? `${employee.data.firstName} ${employee.data.lastName} · ` : ""}${signedLine(f)}${f.supersededAt ? " · replaced by a newer version" : ""}`}>
        <FormStatus form={f} />
        <DownloadPdf form={f} />
      </PageHead>
      <div className="card tablewrap">
        <table><tbody>
          {Object.entries(data.data).filter(([k]) => k !== "signedName").map(([k, v]) => (
            <tr key={k}><td className="muted" style={{ width: 280 }}>{LABELS[k] ?? k}</td><td>{show(v)}</td></tr>
          ))}
        </tbody></table>
      </div>
      {data.employerData && (
        <div className="card">
          <h2>Section 2 (employer)</h2>
          <p className="muted" style={{ marginTop: 0 }}>Signed by {f.employerSignedName}, {fmtDate(f.employerSignedAt)}</p>
          <table><tbody>
            {[...(data.employerData.listA ?? []).map((d: any, i: number) => [`List A #${i + 1}`, d]), ["List B", data.employerData.listB], ["List C", data.employerData.listC]]
              .filter(([, d]) => d)
              .map(([label, d]: any) => (
                <tr key={label}><td className="muted" style={{ width: 280 }}>{label}</td><td>{d.title} · {d.issuingAuthority} · #{d.number} · expires {d.expires || "N/A"}</td></tr>
              ))}
            <tr><td className="muted">First day of employment</td><td>{data.employerData.firstDayOfEmployment}</td></tr>
            <tr><td className="muted">Alternative procedure used</td><td>{show(data.employerData.alternativeProcedure)}</td></tr>
            {data.employerData.additionalInfo && <tr><td className="muted">Additional information</td><td>{data.employerData.additionalInfo}</td></tr>}
            <tr><td className="muted">Certified by</td><td>{f.employerSignedName}, {data.employerData.employerTitle}</td></tr>
          </tbody></table>
        </div>
      )}
      {needsSection2 && <Section2 formId={f.id} startDate={employee.data?.startDate} onDone={reload} />}
      {f.processedAt && <p className="muted">Entered in payroll {fmtDate(f.processedAt)}.</p>}
      {can("admin") && data.accessLog.length > 0 && (
        <div className="card">
          <h2>Who has opened this</h2>
          <table><tbody>{data.accessLog.map((l: any, i: number) => (
            <tr key={i}><td>{l.by}</td><td>{l.action === "download" ? "Downloaded PDF" : "Viewed"}</td><td className="muted">{fmtDateTime(l.at)}</td></tr>
          ))}</tbody></table>
        </div>
      )}
    </>
  );
}
