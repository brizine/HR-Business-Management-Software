"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { WIKI_LEVELS, WIKI_LEVEL_LABELS } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { WikiShell, updatedLine, type WikiListItem } from "@/components/wiki";

function AdminSettings() {
  const settings = useApi("/wiki/settings");
  const deleted = useApi<any[]>("/wiki/deleted");
  const { busy, error, run } = useAction();
  if (!settings.data) return null;
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Wiki settings</h2>
      <label style={{ maxWidth: 320 }}>Who can create new pages
        <select value={settings.data.createMin} disabled={busy} onChange={(e) => run(async () => { await api("/wiki/settings", { method: "PUT", body: { createMin: e.target.value } }); settings.reload(); })}>
          {WIKI_LEVELS.map((l) => <option key={l} value={l}>{WIKI_LEVEL_LABELS[l]}</option>)}
        </select>
      </label>
      <p className="muted" style={{ margin: 0 }}>Each page also has its own &ldquo;who can see&rdquo; and &ldquo;who can edit&rdquo; settings, which only admins can change.</p>
      <ErrorBox error={error} />
      {!!deleted.data?.length && (
        <details>
          <summary>Deleted pages ({deleted.data.length})</summary>
          <ul>{deleted.data.map((p) => (
            <li key={p.id}>{p.title} <span className="muted">deleted {fmtDate(p.deletedAt)}</span>{" "}
              <button className="btn sm" onClick={() => api(`/wiki/pages/${p.id}/undelete`, { method: "POST" }).then(() => location.reload())}>Restore</button>
            </li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

function WikiHome() {
  const { can } = useAuth();
  const q = useSearchParams().get("q") ?? "";
  const results = useApi<WikiListItem[]>(q ? `/wiki/pages?q=${encodeURIComponent(q)}` : null);
  const all = useApi<WikiListItem[]>("/wiki/pages");
  const pinned = (all.data ?? []).filter((p) => p.pinned);
  const recent = [...(all.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  return (
    <WikiShell>
      <PageHead title={q ? `Search: “${q}”` : "Company wiki"} sub={q ? undefined : "Policies, how-tos and everything else worth writing down."} />
      {q ? (
        <div className="card">
          {results.data?.length ? (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {results.data.map((p) => (
                <li key={p.id}><Link href={`/wiki/${p.id}`}><strong>{p.title}</strong></Link><div className="muted">{p.snippet}</div></li>
              ))}
            </ul>
          ) : results.data ? <Empty>No pages match. Try a different word.</Empty> : null}
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="card" aria-labelledby="pinned-h">
              <h2 id="pinned-h">Pinned</h2>
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {pinned.map((p) => <li key={p.id}><Link href={`/wiki/${p.id}`}>📌 {p.title}</Link></li>)}
              </ul>
            </section>
          )}
          <section className="card" aria-labelledby="recent-h">
            <h2 id="recent-h">Recently updated</h2>
            {recent.length ? (
              <table><tbody>{recent.map((p) => (
                <tr key={p.id}><td><Link href={`/wiki/${p.id}`}>{p.title}</Link></td><td className="muted">{updatedLine(p)}</td></tr>
              ))}</tbody></table>
            ) : <Empty>No pages yet.</Empty>}
          </section>
          {can("admin") && <AdminSettings />}
        </>
      )}
    </WikiShell>
  );
}

export default function Page() {
  return <Suspense><WikiHome /></Suspense>;
}
