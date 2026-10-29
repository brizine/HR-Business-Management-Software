"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { WIKI_LEVEL_LABELS, type WikiLevel } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";

export type WikiListItem = { id: string; title: string; parentId: string | null; pinned: boolean; viewMin: WikiLevel; editMin: WikiLevel; updatedAt: string; updatedBy: string | null; snippet?: string };

function Tree({ pages, parentId, currentId }: { pages: WikiListItem[]; parentId: string | null; currentId?: string }) {
  const kids = pages.filter((p) => p.parentId === parentId).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title));
  if (!kids.length) return null;
  return (
    <ul className="wiki-tree">
      {kids.map((p) => (
        <li key={p.id}>
          <Link href={`/wiki/${p.id}`} aria-current={p.id === currentId ? "page" : undefined} className={p.id === currentId ? "current" : ""}>
            {p.pinned && <span aria-label="Pinned" title="Pinned">📌 </span>}{p.title}
            {p.viewMin !== "employee" && <span className="sr-only"> ({WIKI_LEVEL_LABELS[p.viewMin]} can see this)</span>}
          </Link>
          <Tree pages={pages} parentId={p.id} currentId={currentId} />
        </li>
      ))}
    </ul>
  );
}

/** Two-column wiki layout: searchable page tree on the left, content on the right. */
export function WikiShell({ currentId, children }: { currentId?: string; children: ReactNode }) {
  const router = useRouter();
  const { data } = useApi<WikiListItem[]>("/wiki/pages");
  const settings = useApi("/wiki/settings");
  const [q, setQ] = useState("");
  return (
    <div className="wiki">
      <nav className="wiki-nav card" aria-label="Wiki pages">
        <form role="search" onSubmit={(e) => { e.preventDefault(); router.push(`/wiki?q=${encodeURIComponent(q)}`); }}>
          <label htmlFor="wiki-search" className="sr-only">Search the wiki</label>
          <input id="wiki-search" type="search" placeholder="Search the wiki" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="row" style={{ margin: "10px 0", justifyContent: "space-between" }}>
          <Link href="/wiki"><strong>Company wiki</strong></Link>
          {settings.data?.canCreate && <Link className="btn sm" href={`/wiki/new${currentId ? `?parent=${currentId}` : ""}`}>+ New page</Link>}
        </div>
        {data ? (data.length ? <Tree pages={data} parentId={null} currentId={currentId} /> : <p className="muted">No pages yet.</p>) : null}
      </nav>
      <div className="wiki-main">{children}</div>
    </div>
  );
}

export function AccessBadges({ viewMin, editMin }: { viewMin: WikiLevel; editMin: WikiLevel }) {
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      Visible to <strong>{WIKI_LEVEL_LABELS[viewMin].toLowerCase()}</strong> · Editable by <strong>{WIKI_LEVEL_LABELS[editMin].toLowerCase()}</strong>
    </span>
  );
}

export const updatedLine = (p: { updatedAt: string; updatedBy: string | null }) => `Updated ${fmtDate(p.updatedAt)}${p.updatedBy ? ` by ${p.updatedBy}` : ""}`;
