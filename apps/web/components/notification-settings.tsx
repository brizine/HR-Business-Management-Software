"use client";
import { useState } from "react";
import { DELIVERY_MODES, NOTIFICATION_CATEGORY_INFO, type DeliveryMode, type NotificationPreference } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

const MODE_LABELS: Record<DeliveryMode, string> = { never: "Off", no_app: "Only if no app", always: "Always" };

/** Per-category matrix of app / email / text delivery for one person. */
export function NotificationSettings({ employeeId }: { employeeId?: string }) {
  const { me } = useAuth();
  const self = !employeeId || employeeId === me?.user.id;
  const qs = employeeId ? `?employeeId=${employeeId}` : "";
  const { data, setData, error } = useApi(`/notifications/preferences${qs}`);
  const [phone, setPhone] = useState<string | null>(null);
  const { busy, error: saveError, run } = useAction();

  if (!data) return <ErrorBox error={error} />;
  const { employee, channels, hasApp } = data;
  const prefs: NotificationPreference[] = data.preferences;

  const save = (body: object) => run(async () => setData(await api(`/notifications/preferences${qs}`, { method: "PUT", body })));
  const update = (category: string, patch: Partial<NotificationPreference>) =>
    save({ preferences: prefs.map((p) => (p.category === category ? { ...p, ...patch } : p)) });

  return (
    <>
      <div className="card">
        <h2>How {self ? "you" : `${employee.firstName}`} get{self ? "" : "s"} notified</h2>
        <div className="formgrid">
          <div>
            <div className="muted">Phone app</div>
            {hasApp ? "Signed in on a phone" : <span>Not installed{self ? ": install the Crewdesk app to get push alerts" : ""}</span>}
          </div>
          <div>
            <div className="muted">Email</div>
            {employee.email}
            {!channels.email && <div className="muted">Email isn&apos;t set up on this server yet.</div>}
          </div>
          <div>
            <div className="muted">Mobile number for texts</div>
            {self ? (
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api("/employees/me/profile", { method: "PATCH", body: { phone: phone ?? employee.phone ?? "" } });
                  setData(await api(`/notifications/preferences${qs}`));
                  setPhone(null);
                });
              }}>
                <input value={phone ?? employee.phone ?? ""} onChange={(e) => setPhone(e.target.value)} placeholder="(512) 555-0100" style={{ width: 170 }} />
                {phone !== null && <button className="btn sm">Save</button>}
              </form>
            ) : (employee.phone ?? "—")}
            {employee.phone && !employee.phoneTextable && <div className="muted">This doesn&apos;t look like a mobile number we can text.</div>}
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={employee.smsOptIn}
              disabled={busy || !employee.phoneTextable}
              onChange={(e) => save({ smsOptIn: e.target.checked })}
            />
            {self
              ? "Yes, text me Crewdesk notifications. Message & data rates may apply; reply STOP to opt out."
              : `${employee.firstName} agreed to receive texts (only check this if they told you so)`}
          </label>
          {employee.smsOptIn && employee.smsOptInAt && <div className="muted" style={{ marginLeft: 22 }}>Opted in {new Date(employee.smsOptInAt).toLocaleDateString()}</div>}
          {!channels.sms && <div className="muted" style={{ marginLeft: 22 }}>Texts are turned off for your company, so none will be sent.</div>}
        </div>
      </div>

      <div className="card tablewrap">
        <table>
          <thead>
            <tr>
              <th>Notification</th>
              <th>App &amp; inbox</th>
              <th>Email</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => {
              const info = NOTIFICATION_CATEGORY_INFO[p.category];
              return (
                <tr key={p.category}>
                  <td><strong>{info.label}</strong><div className="muted">{info.description}</div></td>
                  <td>
                    <label className="check"><input type="checkbox" checked={p.app} disabled={busy} onChange={(e) => update(p.category, { app: e.target.checked })} /> {p.app ? "On" : "Muted"}</label>
                  </td>
                  <td>
                    <select value={p.email} disabled={busy} onChange={(e) => update(p.category, { email: e.target.value as DeliveryMode })} style={{ width: 150 }}>
                      {DELIVERY_MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={p.sms} disabled={busy || !employee.smsOptIn} onChange={(e) => update(p.category, { sms: e.target.value as DeliveryMode })} style={{ width: 150 }}
                      title={employee.smsOptIn ? "" : "Turn on texts above first"}>
                      {DELIVERY_MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ErrorBox error={saveError} />
        <p className="muted">&ldquo;Only if no app&rdquo; sends email or text when {self ? "you aren't" : "they aren't"} signed in to the Crewdesk app on any phone. Changes save automatically.</p>
      </div>
    </>
  );
}

/** Owner switch for company-wide texting, plus which providers the server has configured. */
export function CompanyNotificationSettings() {
  const { can } = useAuth();
  const { data, setData } = useApi(can("admin") ? "/notifications/company-settings" : null);
  const { busy, error, run } = useAction();
  if (!data) return null;
  return (
    <div className="card">
      <h2>Company settings</h2>
      <label className="check">
        <input type="checkbox" checked={data.smsEnabled} disabled={!can("owner") || busy}
          onChange={(e) => run(async () => setData(await api("/notifications/company-settings", { method: "PUT", body: { smsEnabled: e.target.checked } })))} />
        Allow text messages (each text costs a few cents through your SMS provider)
      </label>
      <ErrorBox error={error} />
      <p className="muted">
        Email provider: {data.emailConfigured ? "connected" : "not configured (set SMTP_URL on the server)"} ·
        SMS provider: {data.smsConfigured ? "connected" : "not configured (set the TWILIO_* variables on the server)"}
        {!can("owner") && " · Only the owner can change these."}
      </p>
    </div>
  );
}
