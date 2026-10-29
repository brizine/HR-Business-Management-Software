"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { download, fmtDate } from "@/lib/api";
import { ErrorBox } from "./ui";

/** The signing block at the end of each form: the exact statement, a typed name, and an "I agree" box. */
export function SignatureBlock({ statement, defaultName, busy, error, submitLabel = "Sign and submit" }: {
  statement: string; defaultName: string; busy: boolean; error: string | null; submitLabel?: string;
}) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Sign</h2>
      <p style={{ margin: 0 }}>{statement}</p>
      <div className="formgrid">
        <label>Type your full legal name<input name="signedName" defaultValue={defaultName} required autoComplete="name" /></label>
      </div>
      <label className="check"><input type="checkbox" required /> I agree that typing my name is my electronic signature on this form.</label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "Submitting…" : submitLabel}</button>
        <Link className="btn" href="/tax-forms">Cancel</Link>
      </div>
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{title}</h2>
      {hint && <p className="muted" style={{ margin: 0 }}>{hint}</p>}
      {children}
    </div>
  );
}

export function FormStatus({ form }: { form: any }) {
  if (form.type === "i9") return form.status === "completed" ? <span className="badge ok">verified</span> : <span className="badge warn">awaiting HR check</span>;
  return form.processedAt ? <span className="badge ok">entered in payroll</span> : <span className="badge">submitted</span>;
}

export function DownloadPdf({ form }: { form: any }) {
  // The server names the file, e.g. W-4-Lee-Jordan-2026-10-29.pdf.
  return <button className="btn sm" onClick={() => download(`/tax-forms/${form.id}/pdf`)}>PDF</button>;
}

export const signedLine = (f: any) => `Signed by ${f.signedName}, ${fmtDate(f.signedAt)}`;

/** Inputs shared by the W-4 and I-9: home address. */
export function AddressFields({ d }: { d: any }) {
  return (
    <div className="formgrid">
      <label>Street address<input name="address" defaultValue={d.address} required autoComplete="address-line1" /></label>
      <label>Apt. (optional)<input name="apt" defaultValue={d.apt} autoComplete="address-line2" /></label>
      <label>City<input name="city" defaultValue={d.city} required autoComplete="address-level2" /></label>
      <label>State<input name="state" defaultValue={d.state} required maxLength={2} placeholder="TX" style={{ textTransform: "uppercase" }} autoComplete="address-level1" /></label>
      <label>ZIP code<input name="zip" defaultValue={d.zip} required inputMode="numeric" autoComplete="postal-code" /></label>
    </div>
  );
}

/** Reads a form into an object: empty fields dropped, numbers as numbers, checkboxes as booleans, state upper-cased. */
export function readForm(form: HTMLFormElement) {
  const out: Record<string, any> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else if (el.value === "") continue;
    else if (el.type === "number") out[el.name] = Number(el.value);
    else out[el.name] = el.name === "state" ? el.value.toUpperCase() : el.value;
  }
  return out;
}
