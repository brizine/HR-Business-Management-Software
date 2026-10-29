"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

function ResetPassword() {
  const token = useSearchParams().get("token");
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <div className="authwrap">
      <div className="card authcard">
        <h1>Choose a new password</h1>
        {done ? (
          <>
            <p>Your password has been changed and you&apos;ve been signed out everywhere else.</p>
            <Link className="btn primary" href="/login">Sign in</Link>
          </>
        ) : (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (f.get("password") !== f.get("confirm")) return setError("The two passwords don't match");
            run(async () => { await api("/auth/reset-password", { body: { token, password: f.get("password") } }); setDone(true); });
          }}>
            <label>New password<input name="password" type="password" minLength={8} required autoComplete="new-password" /></label>
            <label>Type it again<input name="confirm" type="password" minLength={8} required autoComplete="new-password" /></label>
            <ErrorBox error={!token ? "This link is missing its token. Ask for a new one." : error} />
            <button className="btn primary" disabled={busy || !token}>Save password</button>
            <p className="muted"><Link href="/forgot-password">Ask for a new link</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><ResetPassword /></Suspense>;
}
