"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** Landing page for the unsubscribe link in emails. Works without signing in. */
function Unsubscribe() {
  const token = useSearchParams().get("token");
  const [done, setDone] = useState<{ label: string; email: string } | null>(null);
  const { busy, error, run } = useAction();

  return (
    <div className="authwrap">
      <div className="card authcard">
        {done ? (
          <>
            <h1>You&apos;re unsubscribed</h1>
            <p>{done.email} won&apos;t get <strong>{done.label}</strong> emails anymore. You&apos;ll still see them in the app.</p>
            <p className="muted">Changed your mind? <Link href="/settings/notifications">Notification settings</Link></p>
          </>
        ) : (
          <>
            <h1>Unsubscribe</h1>
            <p>Stop getting these emails from Crewdesk?</p>
            <ErrorBox error={!token ? "This link is missing its token." : error} />
            <button className="btn primary" disabled={!token || busy}
              onClick={() => run(async () => setDone(await api(`/public/unsubscribe?token=${encodeURIComponent(token!)}`, { method: "POST" })))}>
              Unsubscribe
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Unsubscribe /></Suspense>;
}
