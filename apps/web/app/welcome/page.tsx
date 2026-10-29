"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { TwoFactorSetup } from "@/components/two-factor-setup";

/** Where a new hire's invite email lands: choose a password (and two-factor if required), then the checklist. */
function Welcome() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const { signIn } = useAuth();
  const [info, setInfo] = useState<{ firstName: string; email: string; company: string; startDate: string | null } | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    api(`/auth/invite?token=${encodeURIComponent(token)}`).then(setInfo, (e) => setError(e.message));
  }, [token, setError]);

  const finish = async () => {
    await signIn();
    router.replace("/onboarding");
  };

  return (
    <div className="authwrap">
      <div className="card authcard" style={setupToken ? { maxWidth: 520 } : undefined}>
        {setupToken ? (
          <>
            <h1>One more step: two-factor sign-in</h1>
            <p className="muted">{info?.company} requires a code from your phone when you sign in. This takes about a minute.</p>
            <TwoFactorSetup token={setupToken} onDone={() => finish()} />
          </>
        ) : info ? (
          <>
            <h1>Welcome to {info.company}, {info.firstName}!</h1>
            <p className="muted">
              Choose a password for Biz Management Software. You&apos;ll sign in as <strong>{info.email}</strong>.
              {info.startDate && <> Your start date is {fmtDate(info.startDate)}.</>}
            </p>
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (f.get("password") !== f.get("confirm")) return setError("The two passwords don't match");
              run(async () => {
                const res = await api("/auth/accept-invite", { body: { token, password: f.get("password") } });
                if (res.mfaSetupRequired) setSetupToken(res.setupToken);
                else await finish();
              });
            }}>
              <label>Password (at least 8 characters)<input name="password" type="password" minLength={8} required autoComplete="new-password" /></label>
              <label>Type it again<input name="confirm" type="password" minLength={8} required autoComplete="new-password" /></label>
              <ErrorBox error={error} />
              <button className="btn primary" disabled={busy}>Create my account</button>
            </form>
            <p className="muted" style={{ fontSize: 13 }}>Next you&apos;ll see your onboarding checklist. On your phone, you can also install the Biz Management Software app and sign in with the same email and password.</p>
          </>
        ) : (
          <>
            <h1>Welcome</h1>
            <ErrorBox error={error} />
            {!error && <p className="muted">Loading…</p>}
          </>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Welcome /></Suspense>;
}
