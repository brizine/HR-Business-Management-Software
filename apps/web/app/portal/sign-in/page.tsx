"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { PortalFrame } from "@/components/portal";

/**
 * The link in the sign-in email. It waits for a click rather than signing in on its own, so an
 * email scanner that opens links can't use it up first.
 */
function LinkSignIn() {
  const link = useSearchParams().get("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(link ? null : "This link is missing its code. Use the 6-digit code from the email instead.");
  return (
    <PortalFrame company={null}>
      <div className="pt-card pt-signin">
        <h1 className="pt-h1">Sign in to your account</h1>
        <button className="pt-btn primary big" disabled={!link || busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await api("/portal/link", { body: { link } }); window.location.href = "/portal"; } catch (e) { setError((e as Error).message); setBusy(false); }
        }}>{busy ? "Signing in…" : "Continue to my account"}</button>
        {error && <p className="pt-note bad" role="alert">{error} <a href="/portal">Get a new code</a></p>}
      </div>
    </PortalFrame>
  );
}

export default function Page() {
  return <Suspense><LinkSignIn /></Suspense>;
}
