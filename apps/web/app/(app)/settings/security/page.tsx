"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { RecoveryCodes, TwoFactorSetup } from "@/components/two-factor-setup";

const POLICY_LABELS: Record<string, string> = {
  none: "Nobody (optional for everyone)",
  owner: "Owners only",
  admin: "Owners and admins",
  manager: "Managers, admins and owners",
  employee: "Everyone",
};

function TwoFactorCard() {
  const status = useApi("/auth/security");
  const [mode, setMode] = useState<"idle" | "setup" | "codes" | "disable">("idle");
  const [codes, setCodes] = useState<string[] | null>(null);
  const { busy, error, run } = useAction();
  const s = status.data;
  if (!s) return null;

  return (
    <div className="card">
      <h2>Two-factor sign-in</h2>
      {mode === "setup" ? (
        <TwoFactorSetup onDone={() => { setMode("idle"); status.reload(); }} />
      ) : codes ? (
        <RecoveryCodes codes={codes} onSaved={() => { setCodes(null); setMode("idle"); status.reload(); }} />
      ) : s.twoFactorEnabled ? (
        <div className="stack">
          <p style={{ margin: 0 }}>✓ On since {fmtDate(s.twoFactorEnabledAt)}. Signing in asks for a code from your authenticator app.</p>
          <p className="muted" style={{ margin: 0 }}>
            {s.recoveryCodesLeft} unused backup code{s.recoveryCodesLeft === 1 ? "" : "s"} left.
            {s.recoveryCodesLeft <= 3 && " Make new ones soon."}
          </p>
          {(mode === "codes" || mode === "disable") && (
            <form className="row" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              run(async () => {
                if (mode === "codes") setCodes((await api("/auth/mfa/recovery-codes", { body: { code: f.get("code") } })).recoveryCodes);
                else { await api("/auth/mfa/disable", { body: { code: f.get("code"), password: f.get("password") } }); setMode("idle"); status.reload(); }
              });
            }}>
              {mode === "disable" && <input name="password" type="password" placeholder="Your password" required style={{ width: 180 }} />}
              <input name="code" placeholder="Current code" required autoComplete="one-time-code" style={{ width: 140 }} />
              <button className="btn primary" disabled={busy}>{mode === "codes" ? "Make new codes" : "Turn off"}</button>
              <button type="button" className="btn" onClick={() => setMode("idle")}>Cancel</button>
            </form>
          )}
          <ErrorBox error={error} />
          {mode === "idle" && (
            <div className="row">
              <button className="btn" onClick={() => setMode("codes")}>New backup codes</button>
              {s.twoFactorRequired
                ? <span className="muted">Required for your role, so it can&apos;t be turned off.</span>
                : <button className="btn danger" onClick={() => setMode("disable")}>Turn off</button>}
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          <p style={{ margin: 0 }}>Protect your account with a code from your phone in addition to your password.</p>
          <div><button className="btn primary" onClick={() => setMode("setup")}>Set up two-factor</button></div>
        </div>
      )}
    </div>
  );
}

function PasswordCard() {
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <div className="card">
      <h2>Password</h2>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        if (f.get("newPassword") !== f.get("confirm")) return setError("The new passwords don't match");
        run(async () => {
          // The API sends this browser a fresh session cookie; other devices are signed out.
          await api("/auth/password", { body: { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") } });
          form.reset();
          setDone(true);
        });
      }}>
        <div className="formgrid">
          <label>Current password<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
          <label>New password<input name="newPassword" type="password" minLength={8} required autoComplete="new-password" /></label>
          <label>New password again<input name="confirm" type="password" minLength={8} required autoComplete="new-password" /></label>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy}>Change password</button>
          {done && <span className="muted">Changed. Your other devices have been signed out.</span>}
        </div>
      </form>
    </div>
  );
}

function SessionsCard() {
  const { signOut } = useAuth();
  const router = useRouter();
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <h2>Signed-in devices</h2>
      <p className="muted" style={{ marginTop: 0 }}>Lost a phone, or signed in on a shared computer? This signs you out of Crewdesk everywhere, including here, and stops notifications to your phones until you sign in again.</p>
      <ErrorBox error={error} />
      <button className="btn danger" disabled={busy} onClick={() => confirm("Sign out of Crewdesk on every device?") && run(async () => {
        await api("/auth/logout-all", { method: "POST" });
        await signOut();
        router.replace("/login");
      })}>Sign out everywhere</button>
    </div>
  );
}

function PolicyCard() {
  const { can } = useAuth();
  const { data, setData } = useApi(can("admin") ? "/auth/policy" : null);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  if (!data) return null;
  return (
    <div className="card">
      <h2>Company: who must use two-factor</h2>
      <div className="row">
        <select value={data.twoFactorRequiredFor} disabled={!can("owner") || busy} style={{ width: 280 }} onChange={(e) => {
          const value = e.target.value;
          if (!confirm(`Require two-factor for: ${POLICY_LABELS[value]}? People newly covered who haven't set it up will be signed out and walked through setup next time they sign in.`)) return;
          run(async () => {
            const res = await api("/auth/policy", { method: "PUT", body: { twoFactorRequiredFor: value } });
            setData({ twoFactorRequiredFor: res.twoFactorRequiredFor });
            setNote(res.signedOut ? `${res.signedOut} ${res.signedOut === 1 ? "person was" : "people were"} signed out to set it up.` : null);
          });
        }}>
          {Object.entries(POLICY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {note && <span className="muted">{note}</span>}
      </div>
      <ErrorBox error={error} />
      <p className="muted">
        Anyone can turn it on for themselves. If someone loses their phone and backup codes, an admin can reset it from their profile.
        {!can("owner") && " Only the owner can change this."}
      </p>
    </div>
  );
}

export default function Security() {
  return (
    <>
      <PageHead title="Settings" />
      <SettingsTabs />
      <TwoFactorCard />
      <PasswordCard />
      <SessionsCard />
      <PolicyCard />
    </>
  );
}
