"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, fmtDateTime } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { WikiShell } from "@/components/wiki";

export default function WikiHistory({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const page = useApi(`/wiki/pages/${id}`);
  const revs = useApi<any[]>(`/wiki/pages/${id}/revisions`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <WikiShell currentId={id}>
      <PageHead title={`History: ${page.data?.title ?? ""}`}><Link className="btn" href={`/wiki/${id}`}>Back to page</Link></PageHead>
      <ErrorBox error={revs.error} />
      <ol className="card stack" style={{ listStyle: "none", margin: 0 }}>
        {revs.data?.map((r, i) => (
          <li key={r.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{fmtDateTime(r.createdAt)}</strong> · {r.editedBy ?? "Unknown"} {i === 0 && <span className="badge ok">current</span>}
                <div className="muted">{r.note || "No note"}{r.title !== page.data?.title && ` · titled “${r.title}”`}</div>
              </div>
              <div className="row">
                <button className="btn sm" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "View"}</button>
                {i > 0 && (
                  <button className="btn sm" onClick={() => confirm("Restore this version? The current text stays in the history.")
                    && api(`/wiki/pages/${id}/restore/${r.id}`, { method: "POST" }).then(() => router.push(`/wiki/${id}`))}>Restore</button>
                )}
              </div>
            </div>
            {open === r.id && <div className="card" style={{ marginTop: 8 }}><Markdown>{r.body || "_Empty_"}</Markdown></div>}
          </li>
        ))}
      </ol>
    </WikiShell>
  );
}
