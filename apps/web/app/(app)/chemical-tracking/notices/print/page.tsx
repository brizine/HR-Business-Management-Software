"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";

interface Page { id: string | null; status: string | null; customerName: string; siteAddress: string | null; appliedOn: string | null; subject: string | null; body: string }

/** Printed notices, one to a page: left at the door or mailed. `?ids=` for saved notices, `?record=` for any record. */
export default function PrintNotices() {
  return <Suspense><PrintNoticesInner /></Suspense>;
}

function PrintNoticesInner() {
  const q = useSearchParams();
  const { me } = useAuth();
  const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
  const record = q.get("record");
  const [pages, setPages] = useState<Page[] | null>(null);
  const [done, setDone] = useState(false);
  const act = useAction();
  useEffect(() => {
    act.run(async () => {
      if (record) {
        const n = await api<{ subject: string; body: string; customerName: string; siteAddress: string | null }>(`/chemical-tracking/records/${record}/notice-preview`);
        setPages([{ id: null, status: null, appliedOn: null, ...n }]);
      } else {
        const list = await Promise.all(ids.map((id) => api<Page & { recordId: string }>(`/chemical-tracking/notices/${id}`)));
        setPages(list);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const waiting = (pages ?? []).filter((p) => p.id && p.status === "to_print").map((p) => p.id!);
  const markPrinted = () => act.run(async () => { await api("/chemical-tracking/notices/printed", { method: "POST", body: { ids: waiting } }); setDone(true); });
  return (
    <>
      <div className="noprint">
        <PageHead title={`Print ${pages?.length ?? ""} notice${pages?.length === 1 ? "" : "s"}`} sub="One to a page. Leave at the door or mail.">
          <button className="btn primary" onClick={() => window.print()} disabled={!pages?.length}>Print</button>
          {waiting.length > 0 && !done && <button className="btn" disabled={act.busy} onClick={markPrinted}>Mark {waiting.length} printed</button>}
          {done && <span className="badge ok">Marked printed</span>}
        </PageHead>
        <ErrorBox error={act.error} />
      </div>
      {(pages ?? []).map((p, i) => (
        <article key={p.id ?? i} className="card notice-page" style={{ marginBottom: 16, maxWidth: 680 }}>
          <h2 style={{ margin: "0 0 4px" }}>{me?.company.name}</h2>
          <p className="muted" style={{ margin: "0 0 16px" }}>{p.customerName}{p.siteAddress ? ` · ${p.siteAddress}` : ""}{p.appliedOn ? ` · ${fmtDate(p.appliedOn)}` : ""}</p>
          {p.subject && <h3 style={{ margin: "0 0 12px" }}>{p.subject}</h3>}
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{p.body}</div>
        </article>
      ))}
    </>
  );
}
