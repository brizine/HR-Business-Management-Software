"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** Landing page for the unsubscribe link in emails. Works without signing in. */
function Unsubscribe() {
  const params = useSearchParams();
  const customer = params.get("customer");
  return customer ? <CustomerUnsubscribe token={customer} /> : <StaffUnsubscribe token={params.get("token")} />;
}

/** A staff member's link from a notification email: turns off that category's emails. */
function StaffUnsubscribe({ token }: { token: string | null }) {
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

/** A customer's link from an email sent to many customers. Invoices and receipts still go. */
function CustomerUnsubscribe({ token }: { token: string }) {
  const [done, setDone] = useState<{ company: string; email: string | null } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="authwrap">
      <div className="card authcard">
        {done ? (
          <>
            <h1>You&apos;re unsubscribed</h1>
            <p>{done.email ?? "You"} won&apos;t get emails like this from <strong>{done.company}</strong> anymore. You&apos;ll still get your invoices and receipts.</p>
            <p className="muted">Changed your mind? Reply to any of their emails or give them a call.</p>
          </>
        ) : (
          <>
            <h1>Unsubscribe</h1>
            <p>Stop getting these emails? You&apos;ll still get your invoices and receipts.</p>
            <ErrorBox error={error} />
            <button className="btn primary" disabled={busy}
              onClick={() => run(async () => setDone(await api(`/public/unsubscribe/customer?token=${encodeURIComponent(token)}`, { method: "POST" })))}>
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
