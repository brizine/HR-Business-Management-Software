"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead, formValues } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";

type Info = { name: string; legalName: string | null; ein: string | null; address: string | null; phone: string | null; email: string | null; website: string | null; timezone: string; canEdit: boolean };

const US_ZONES = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona (no daylight saving)"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"],
];

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
      <PageHead title="Company info" sub={d?.canEdit ? "Your company's details. The name shows in the sidebar; the legal name, EIN and address print on tax forms." : "Your company's details."} />
      <SettingsTabs />
      {!d ? <ErrorBox error={info.error} /> : (
        <form className="card stack" onChange={() => setSaved(false)} onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          run(async () => {
            info.setData(await api<Info>("/company", { method: "PUT", body: {
              name: v.name ?? "", legalName: v.legalName ?? "", ein: v.ein ?? "", address: v.address ?? "",
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
            <label>Business address<textarea name="address" rows={2} maxLength={300} defaultValue={d.address ?? ""} placeholder={"Street\nCity, State ZIP"} /></label>
            <div className="formgrid">
              <label>Phone<input name="phone" type="tel" maxLength={40} defaultValue={d.phone ?? ""} /></label>
              <label>Email<input name="email" type="email" maxLength={200} defaultValue={d.email ?? ""} placeholder="office@example.com" /></label>
              <label>Website<input name="website" maxLength={200} defaultValue={d.website ?? ""} placeholder="prospray.biz" /></label>
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
