"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { QrCode } from "./qr";
import { ErrorBox } from "./ui";

/**
 * Walks through turning on two-factor: scan the QR in an authenticator app,
 * confirm with a code, then save the backup codes. `token` is the setup-only
 * token from sign-in; omit it when already signed in.
 */
export function TwoFactorSetup({ token, onDone }: { token?: string; onDone: (result: { token?: string }) => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [result, setResult] = useState<{ recoveryCodes: string[]; token?: string } | null>(null);
  const [code, setCode] = useState("");
  const { busy, error, run } = useAction();

  // Start setup exactly once: each call makes a new secret, and a second call
  // (e.g. React's development double-render) would invalidate the QR shown.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run(async () => setSetup(await api("/auth/mfa/setup", { method: "POST", token })));
  }, [run, token]);

  if (result) return <RecoveryCodes codes={result.recoveryCodes} onSaved={() => onDone({ token: result.token })} />;
  if (!setup) return <ErrorBox error={error} />;

  return (
    <div className="stack">
      <ol className="stack" style={{ paddingLeft: 18, margin: 0 }}>
        <li>Install an authenticator app on your phone if you don&apos;t have one (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>In the app, add an account and scan this code:</li>
      </ol>
      <div className="row" style={{ gap: 16 }}>
        <QrCode value={setup.otpauthUri} size={168} />
        <div className="muted" style={{ maxWidth: 260 }}>
          Can&apos;t scan? Enter this key instead:
          <div><code style={{ wordBreak: "break-all", letterSpacing: ".04em" }}>{setup.secret.match(/.{1,4}/g)!.join(" ")}</code></div>
        </div>
      </div>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        run(async () => setResult(await api("/auth/mfa/enable", { body: { code }, token })));
      }}>
        <label>3. Enter the 6-digit code the app shows
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required style={{ maxWidth: 160, fontSize: 18, letterSpacing: ".15em" }} />
        </label>
        <ErrorBox error={error} />
        <div><button className="btn primary" disabled={busy}>Turn on two-factor</button></div>
      </form>
    </div>
  );
}

export function RecoveryCodes({ codes, onSaved }: { codes: string[]; onSaved: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = `Crewdesk backup codes (each works once)\n\n${codes.join("\n")}\n`;
  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>Save your backup codes</h2>
      <p className="muted" style={{ margin: 0 }}>
        If you lose your phone, each of these lets you sign in once. Store them somewhere safe, like a password
        manager or a printed copy. They won&apos;t be shown again.
      </p>
      <pre className="codes">{codes.join("\n")}</pre>
      <div className="row">
        <button className="btn" onClick={() => navigator.clipboard.writeText(text)}>Copy</button>
        <button className="btn" onClick={() => {
          const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
          Object.assign(document.createElement("a"), { href: url, download: "crewdesk-backup-codes.txt" }).click();
          URL.revokeObjectURL(url);
        }}>Download</button>
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I&apos;ve saved these codes</label>
      <div><button className="btn primary" disabled={!saved} onClick={onSaved}>Continue</button></div>
    </div>
  );
}
