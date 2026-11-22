"use client";
import { useEffect, useRef, useState } from "react";
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
/** Leaves the test company for the real one. */
export async function backToRealCompany() {
  await api("/auth/test-company/back", { method: "POST" });
  go("/customers");
}

/**
 * In the test company: a yellow TEST badge next to the company name in the top bar. Click it for what
 * that means and the way back to the real company.
 */
export function TestBadge() {
  const { me } = useAuth();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (!me?.company.isTest) return null;
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="test-badge" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} title="You're in the test company">TEST</button>
      {open && (
        <div className="topbar-popover test-pop" role="dialog" aria-label="Test company">
          <strong>Test company</strong>
          <p className="muted" style={{ margin: "4px 0 10px" }}>Sample customers and test-mode payments only; nothing here is real or reaches your real books.</p>
          <button className="btn primary" disabled={busy} onClick={() => run(backToRealCompany)}>Back to the real company</button>
          {error && <p className="error" style={{ margin: "8px 0 0" }}>{error}</p>}
        </div>
      )}
    </div>
  );
}
