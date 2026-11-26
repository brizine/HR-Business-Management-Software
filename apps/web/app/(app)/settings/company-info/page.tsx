"use client";
import { useMemo, useRef, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { fitLogo } from "@/lib/logo";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead, formValues } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { TestCompanyCard } from "@/components/test-company";
import { BusinessAddressFields, businessAddressValues } from "@/components/business-address-fields";
import { phoneInput } from "@/lib/phone-input";
import { formatPhone } from "@crewdesk/shared";

type Info = { hasLogo: boolean; logoFitted?: boolean; logoUpdatedAt: string | null; name: string; legalName: string | null; ein: string | null; address: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; email: string | null; website: string | null; timezone: string; canEdit: boolean };

const US_ZONES = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona (no daylight saving)"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"],
];

/** The company logo: shown here and in everyone's top bar, in place of the company name. The owner adds, changes or removes it. */
function LogoCard({ info, onChange }: { info: Info; onChange: (i: Info) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const version = info.logoUpdatedAt ? `&v=${encodeURIComponent(info.logoUpdatedAt)}` : "";
  /** Fits the picture (blank border off, sized for print and for screens) and saves both copies. */
  const upload = async (picture: () => Promise<Blob>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const fit = await fitLogo(await picture());
      const fd = new FormData();
      fd.append("file", fit.full, "logo.png");
      fd.append("small", fit.small, "logo-small.png");
      await onChange(await api<Info>("/company/logo", { method: "PUT", body: fd }));
      const f = fit.sizes.full, sm = fit.sizes.small;
      // Smaller than a sharp screen draws it in the top bar: worth saying, since a larger original fixes it.
      const soft = f.width < 440 && f.height < 80;
      setDone(`${fit.trimmed ? "Trimmed the blank border and saved it" : "Saved it"} at ${f.width} × ${f.height} for print and emails${sm.width < f.width ? `, and ${sm.width} × ${sm.height} for screens` : ""}.`
        + (soft ? " That is small, so it may look soft on sharp screens: upload a larger original if you have one." : ""));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  /** The logo as it is saved now, for one added before Crewdesk fitted them: nobody has to find the file again. */
  const saved = async () => {
    const res = await fetch(`${API_URL}/company/logo?size=full${version}`, { credentials: "include" });
    if (!res.ok) throw new Error("Couldn't load the logo. Upload it again instead.");
    return res.blob();
  };
  return (
    <div className="card row" style={{ alignItems: "center", gap: 16 }}>
      <div className="logo-preview">
        {info.hasLogo
          ? <img src={`${API_URL}/company/logo?size=small${version}`} alt={`${info.name} logo`} />
          : <span className="muted">No logo</span>}
      </div>
      <div className="stack" style={{ flex: 1, minWidth: 200 }}>
        <strong>Company Logo</strong>
        <span className="muted" style={{ fontSize: 13 }}>
          Shows at the left of everyone&apos;s top bar, in place of the company name. JPEG, PNG or WebP up to 5 MB; a transparent PNG looks best.
          Upload it at any size: Crewdesk trims the blank border around it and saves it at the right sizes for the top bar, the customer portal, emails and printed invoices.
        </span>
        {info.canEdit && (
          <div className="row">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(async () => f); }} />
            <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Working…" : info.hasLogo ? "Change logo" : "Add logo"}</button>
            {info.hasLogo && <button type="button" className="btn sm" disabled={busy} onClick={() => confirm("Remove the company logo?") && api<Info>("/company/logo", { method: "DELETE" }).then((i) => { setDone(null); return onChange(i); }, (e) => setError(e.message))}>Remove</button>}
          </div>
        )}
        {info.canEdit && info.hasLogo && info.logoFitted === false && !busy && (
          <div className="notice row" role="note" style={{ gap: 10, alignItems: "center" }}>
            <span style={{ flex: 1, minWidth: 180 }}>This logo was added before Crewdesk trimmed and sized logos. Fit it now, or upload the original again for the sharpest result.</span>
            <button type="button" className="btn sm" onClick={() => void upload(saved)}>Fit this logo</button>
          </div>
        )}
        {done && <span className="muted" role="status" style={{ fontSize: 13 }}>{done}</span>}
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

/** Settings → Company info: name, legal details, contact details and time zone. Everyone can view; the owner edits. */
export default function CompanyInfo() {
  const { signIn } = useAuth();
  const info = useApi<Info>("/company");
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const zones = useMemo(() => {
    let all: string[] = [];
    try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch {}
    return all.filter((z) => !US_ZONES.some(([u]) => u === z));
  }, []);
  const d = info.data;

  return (
    <>
      <PageHead title="Company Info" sub={d?.canEdit ? "Your company's details. The name shows in the top bar until you add a logo, which takes its place; the legal name, EIN and address print on tax forms." : "Your company's details."} />
      <SettingsTabs />
      {d && <LogoCard info={d} onChange={async (next) => { info.setData(next); await signIn(); }} />}
      {!d ? <ErrorBox error={info.error} /> : (
        <form className="card stack" onChange={() => setSaved(false)} onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          run(async () => {
            info.setData(await api<Info>("/company", { method: "PUT", body: {
              name: v.name ?? "", legalName: v.legalName ?? "", ein: v.ein ?? "", ...businessAddressValues((k) => v[k] ?? ""),
              phone: v.phone ?? "", email: v.email ?? "", website: v.website ?? "", timezone: v.timezone,
            } }));
            setSaved(true);
            await signIn(); // refresh the company name in the top bar
          });
        }}>
          <fieldset disabled={!d.canEdit} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="formgrid">
              <label>Company name<input name="name" required maxLength={120} defaultValue={d.name} /></label>
              <label>Legal business name<input name="legalName" maxLength={200} defaultValue={d.legalName ?? ""} placeholder="e.g. ProSpray LLC" /></label>
              {d.ein !== null || d.canEdit ? (
                <label>Employer ID number (EIN)<input name="ein" defaultValue={d.ein ?? ""} placeholder="12-3456789" /></label>
              ) : null}
            </div>
            <BusinessAddressFields initial={d} />
            <div className="formgrid">
              <label>Phone<input name="phone" {...phoneInput} defaultValue={formatPhone(d.phone)} /></label>
              <label>Email<input name="email" type="email" maxLength={200} defaultValue={d.email ?? ""} placeholder="office@example.com" /></label>
              <label>Website<input name="website" maxLength={200} defaultValue={d.website ?? ""} placeholder="example.com" /></label>
              <label>Time zone
                <select name="timezone" defaultValue={d.timezone}>
                  <optgroup label="United States">{US_ZONES.map(([z, l]) => <option key={z} value={z}>{l} ({z})</option>)}</optgroup>
                  {zones.length > 0 && <optgroup label="Other">{zones.map((z) => <option key={z} value={z}>{z}</option>)}</optgroup>}
                  {!US_ZONES.some(([z]) => z === d.timezone) && !zones.includes(d.timezone) && <option value={d.timezone}>{d.timezone}</option>}
                </select>
                <span className="muted" style={{ fontSize: 12 }}>Used for schedules, reminders, pay periods and time-off awards.</span>
              </label>
            </div>
          </fieldset>
          <ErrorBox error={error} />
          {d.canEdit ? (
            <div className="row"><button className="btn primary" disabled={busy}>Save company info</button>{saved && <span className="muted" role="status">Saved.</span>}</div>
          ) : <p className="muted" style={{ margin: 0 }}>Only the owner can change company info.</p>}
        </form>
      )}
      {d?.canEdit && <TestCompanyCard />}
    </>
  );
}
