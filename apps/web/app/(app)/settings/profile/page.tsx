"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead, formValues } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { ContactFields, withClearedContact } from "@/components/contact-fields";

/** Everyone keeps their own phone, home address and emergency contact up to date. */
export default function MyInfo() {
  const { me } = useAuth();
  const emp = useApi(me ? `/employees/${me.user.id}` : null);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const e = emp.data;
  return (
    <>
      <PageHead title="My info" sub="Your phone, date of birth, home address and emergency contact. Only managers and admins can see them." />
      <SettingsTabs />
      {!e ? <ErrorBox error={emp.error} /> : (
        <form className="card stack" onChange={() => setSaved(false)} onSubmit={(ev) => {
          ev.preventDefault();
          const v = withClearedContact(formValues(ev.currentTarget));
          v.phone = v.phone ?? null;
          run(async () => { emp.setData(await api("/employees/me/profile", { method: "PATCH", body: v })); setSaved(true); });
        }}>
          <div className="formgrid">
            <label>Mobile phone<input name="phone" type="tel" defaultValue={e.phone ?? ""} autoComplete="tel" /></label>
          </div>
          <ContactFields initial={e} />
          <ErrorBox error={error} />
          <div className="row">
            <button className="btn primary" disabled={busy}>Save</button>
            {saved && <span className="muted" role="status">Saved.</span>}
          </div>
        </form>
      )}
    </>
  );
}
