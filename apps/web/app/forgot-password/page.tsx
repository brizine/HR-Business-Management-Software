"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox, formValues } from "@/components/ui";

export default function ForgotPassword() {
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="authwrap">
      <div className="card authcard">
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <p>If <strong>{sent}</strong> has a Crewdesk account, we&apos;ve emailed it a link to choose a new password. The link works for an hour.</p>
            <p className="muted">Nothing arrived? Check spam, or ask your Crewdesk admin to set a new password for you.</p>
          </>
        ) : (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const { email } = formValues(e.currentTarget);
            run(async () => { await api("/auth/forgot-password", { body: { email } }); setSent(email); });
          }}>
            <label>Your work email<input name="email" type="email" required autoComplete="email" /></label>
            <ErrorBox error={error} />
            <button className="btn primary" disabled={busy}>Email me a reset link</button>
          </form>
        )}
        <p className="muted"><Link href="/login">Back to sign in</Link></p>
      </div>
    </div>
  );
}
