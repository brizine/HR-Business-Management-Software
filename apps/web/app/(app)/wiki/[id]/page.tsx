"use client";
import Link from "next/link";
import { use } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AccessBadges, WikiShell, updatedLine } from "@/components/wiki";

export default function WikiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: p, error } = useApi(`/wiki/pages/${id}`);

  return (
    <WikiShell currentId={id}>
      {!p ? <ErrorBox error={error} /> : (
        <article className="card" aria-labelledby="wiki-title">
          {p.breadcrumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
              {p.breadcrumbs.map((c: any) => <span key={c.id}><Link href={`/wiki/${c.id}`}>{c.title}</Link> › </span>)}
            </nav>
          )}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <h1 id="wiki-title" style={{ margin: 0 }}>{p.title}</h1>
            <div className="row">
              {p.canEdit && <Link className="btn" href={`/wiki/${id}/edit`}>Edit</Link>}
              {p.canEdit && <Link className="btn" href={`/wiki/${id}/history`}>History</Link>}
              {p.canManage && (
                <button className="btn danger" onClick={() => confirm(`Delete "${p.title}"? Sub-pages move up a level. Admins can restore it from Wiki settings.`)
                  && api(`/wiki/pages/${id}`, { method: "DELETE" }).then(() => router.push("/wiki"))}>Delete</button>
              )}
            </div>
          </div>
          <p className="muted" style={{ margin: "6px 0 14px" }}>{updatedLine(p)} · <AccessBadges viewMin={p.viewMin} editMin={p.editMin} /></p>
          {p.body.trim() ? <Markdown>{p.body}</Markdown> : <Empty>This page is empty.{p.canEdit && <> <Link href={`/wiki/${id}/edit`}>Add some text</Link>.</>}</Empty>}
          {p.children.length > 0 && (
            <section aria-labelledby="sub-h" style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <h2 id="sub-h" style={{ fontSize: 15 }}>Pages in this section</h2>
              <ul>{p.children.map((c: any) => <li key={c.id}><Link href={`/wiki/${c.id}`}>{c.title}</Link></li>)}</ul>
            </section>
          )}
        </article>
      )}
    </WikiShell>
  );
}
