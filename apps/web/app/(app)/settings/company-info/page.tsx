"use client";
import { useMemo, useRef, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { shrink } from "@/components/avatar";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead, formValues } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { BusinessAddressFields, businessAddressValues } from "@/components/business-address-fields";
import { phoneInput } from "@/lib/phone-input";
import { formatPhone } from "@crewdesk/shared";

type Info = { hasLogo: boolean; logoUpdatedAt: string | null; name: string; legalName: string | null; ein: string | null; address: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; email: string | null; website: string | null; timezone: string; canEdit: boolean };

const US_ZONES = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona (no daylight saving)"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"],
];

/** The company logo: shown here and in everyone's sidebar. The owner adds, changes or removes it. */
function LogoCard({ info, onChange }: { info: Info; onChange: (i: Info) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      // PNG keeps transparent backgrounds; 600px is plenty for a logo.
      fd.append("file", await shrink(file, { max: 600, type: "image/png" }), "logo.png");
      await onChange(await api<Info>("/company/logo", { method: "PUT", body: fd }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="card row" style={{ alignItems: "center", gap: 16 }}>
      <div className="logo-preview">
        {info.hasLogo
          ? <img src={`${API_URL}/company/logo${info.logoUpdatedAt ? `?v=${encodeURIComponent(info.logoUpdatedAt)}` : ""}`} alt={`${info.name} logo`} />
          : <span className="muted">No logo</span>}
      </div>
      <div className="stack" style={{ flex: 1, minWidth: 200 }}>
        <strong>Company Logo</strong>
        <span className="muted" style={{ fontSize: 13 }}>Shows at the top of everyone&apos;s sidebar. JPEG, PNG or WebP up to 5 MB; a transparent PNG looks best.</span>
        {info.canEdit && (
          <div className="row">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : info.hasLogo ? "Change logo" : "Add logo"}</button>
            {info.hasLogo && <button type="button" className="btn sm" disabled={busy} onClick={() => confirm("Remove the company logo?") && api<Info>("/company/logo", { method: "DELETE" }).then(onChange, (e) => setError(e.message))}>Remove</button>}
          </div>
        )}
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
      <PageHead title="Company Info" sub={d?.canEdit ? "Your company's details. The name shows in the sidebar; the legal name, EIN and address print on tax forms." : "Your company's details."} />
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
            await signIn(); // refresh the company name in the sidebar
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
    </>
  );
}
