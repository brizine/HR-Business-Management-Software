"use client";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

type Status = { isTest: true; realCompanyName: string | null } | { isTest: false; exists: boolean; name: string | null; canCreate: boolean; canOpen: boolean };

/** Switching companies changes the session, so reload the app there. */
const go = (path: string) => { window.location.href = path; };

export async function openTestCompany() {
  await api("/auth/test-company/open", { method: "POST" });
  go("/customers");
}

export function useTestCompany() {
  return useApi<Status>("/auth/test-company");
}

/** Owner: make, open or delete the test company. Others with access: open it. */
export function TestCompanyCard() {
  const status = useTestCompany();
  const { busy, error, run } = useAction();
  const s = status.data;
  if (!s || s.isTest || (!s.canCreate && !(s.exists && s.canOpen))) return null;
  return (
    <div className="card stack">
      <h2 style={{ fontSize: 16, margin: 0 }}>Test company</h2>
      <p className="muted" style={{ margin: 0 }}>
        A separate company for trying things out with sample customers, test-mode payments and a test Bigcapital organization,
        so nothing touches your real customers or books. Owners, admins and anyone with Customers &amp; billing access can switch in
        without another password; a yellow bar at the top shows you&apos;re in it, with a button back.
      </p>
      <ErrorBox error={error} />
      <div className="row">
        {s.exists ? (
          <>
            {s.canOpen && <button className="btn primary" disabled={busy} onClick={() => run(openTestCompany)}>Open {s.name}</button>}
            {s.canCreate && (
              <button className="btn danger" disabled={busy} onClick={() => confirm(`Delete ${s.name} and everything in it? Your real company isn't affected.`) && run(async () => { await api("/auth/test-company", { method: "DELETE" }); status.reload(); })}>
                Delete test company
              </button>
            )}
          </>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api("/auth/test-company", { method: "POST" }); status.reload(); })}>Create test company</button>
        )}
      </div>
    </div>
  );
}

/** Shown on every page inside the test company. */
export function TestCompanyBanner() {
  const { me } = useAuth();
  const { busy, error, run } = useAction();
  if (!me?.company.isTest) return null;
  return (
    <div className="test-banner" role="status">
      <span><strong>Test company.</strong> Sample data and test-mode payments only; nothing here is real.</span>
      <button className="btn" disabled={busy} onClick={() => run(async () => { await api("/auth/test-company/back", { method: "POST" }); go("/customers"); })}>Back to the real company</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
