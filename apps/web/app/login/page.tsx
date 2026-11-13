"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { loadLastCompanyName } from "@/lib/last-company";
import { ErrorBox, formValues } from "@/components/ui";
import { TwoFactorSetup } from "@/components/two-factor-setup";

type Step = { kind: "password" } | { kind: "code"; mfaToken: string; method: "app" | "email"; emailHint: string } | { kind: "setup"; setupToken: string };

function Login() {
  const { signIn } = useAuth();
  const router = useRouter();
  // Only follow same-site paths, never a full URL, so the link can't bounce people elsewhere.
  const next = useSearchParams().get("next");
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [useBackup, setUseBackup] = useState(false);
  const { busy, error, run, setError } = useAction();
  const [sentNote, setSentNote] = useState<string | null>(null);
  // The company last signed in on this browser (read after mount, since the server can't see it).
  const [companyName, setCompanyName] = useState<string | null>(null);
  useEffect(() => {
    const name = loadLastCompanyName();
    setCompanyName(name);
  }, []);
  // The browser tab too. Next swaps in its default title after the page loads, so keep re-applying it.
  useEffect(() => {
    if (!companyName) return;
    const apply = () => {
      if (document.title !== companyName) document.title = companyName;
    };
    apply();
    const watcher = new MutationObserver(apply);
    watcher.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => watcher.disconnect();
  }, [companyName]);

  /** The API has set the session cookie by now. */
  const finish = async () => {
    await signIn();
    router.replace(target);
  };

  return (
    <div className="authwrap">
      <div className="card authcard" style={step.kind === "setup" ? { maxWidth: 520 } : undefined}>
        {step.kind === "password" && (
          <>
            <h1>{companyName ? `Sign in to ${companyName}` : "Sign in"}</h1>
            <p className="muted">HR, time, and fleet maintenance in one place.</p>
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const body = formValues(e.currentTarget);
              run(async () => {
                const res = await api("/auth/login", { body });
                if (res.mfaRequired) setStep({ kind: "code", mfaToken: res.mfaToken, method: res.method ?? "app", emailHint: res.emailHint ?? "your email" });
                else if (res.mfaSetupRequired) setStep({ kind: "setup", setupToken: res.setupToken });
                else await finish();
              });
            }}>
              <label>Email<input name="email" type="email" required autoComplete="email" /></label>
              <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
              <ErrorBox error={error} />
              <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
            <p className="muted"><Link href="/forgot-password">Forgot your password?</Link></p>
            <p className="muted">New business? <Link href="/signup">Create an account</Link></p>
          </>
        )}

        {step.kind === "code" && (
          <>
            <h1>{step.method === "email" && !useBackup ? "Check your email" : "Two-factor sign-in"}</h1>
            <p className="muted">
              {useBackup ? "Enter one of your backup codes."
                : step.method === "email" ? `We emailed a 6-digit code to ${step.emailHint}. It works for 10 minutes.`
                : "Enter the 6-digit code from your authenticator app."}
            </p>
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const { code } = formValues(e.currentTarget);
              run(async () => {
                const res = await api("/auth/login/mfa", { body: { code: String(code) }, token: step.mfaToken });
                if (res.recoveryCodesLeft <= 2) alert(`You have ${res.recoveryCodesLeft} backup codes left. Make new ones under Settings → Security.`);
                await finish();
              }).then((ok) => {
                if (!ok) (e.target as HTMLFormElement).reset();
              });
            }}>
              <input key={String(useBackup)} name="code" autoFocus required autoComplete="one-time-code"
                inputMode={useBackup ? "text" : "numeric"} placeholder={useBackup ? "xxxxx-xxxxx" : "123456"}
                style={{ fontSize: 20, letterSpacing: ".15em", textAlign: "center" }} />
              <ErrorBox error={error} />
              <button className="btn primary" disabled={busy}>Verify</button>
            </form>
            {sentNote && <p className="muted">{sentNote}</p>}
            <p className="muted">
              <a href="#" onClick={(e) => {
                e.preventDefault();
                run(async () => {
                  const res = await api("/auth/login/mfa/email", { token: step.mfaToken, method: "POST" });
                  setStep({ ...step, method: "email", emailHint: res.emailHint });
                  setUseBackup(false);
                  setSentNote(`New code sent to ${res.emailHint}. Only the newest code works. Check your spam folder if it doesn't arrive.`);
                });
              }}>{step.method === "email" ? "Send a new code" : "Email me a code instead"}</a>
            </p>
            <p className="muted">
              <a href="#" onClick={(e) => { e.preventDefault(); setUseBackup(!useBackup); setError(null); }}>
                {useBackup ? "Use a 6-digit code instead" : step.method === "email" ? "Can't get to your email? Use a backup code" : "Lost your phone? Use a backup code"}
              </a>
            </p>
            <p className="muted" style={{ fontSize: 12 }}>Still stuck? Ask your Crewdesk admin to reset your two-factor.</p>
          </>
        )}

        {step.kind === "setup" && (
          <>
            <h1>Set up two-factor sign-in</h1>
            <p className="muted">Your company requires a code from your phone, in addition to your password, for your role. This takes about a minute.</p>
            <TwoFactorSetup token={step.setupToken} onDone={() => finish()} />
          </>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Login /></Suspense>;
}
