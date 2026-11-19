"use client";
import { useEffect, useState } from "react";
import { countyLabel } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

interface Status {
  counties: { county: string; count: number; loadedAt: string | null; loading: boolean; error: string | null }[];
  all: string[];
  refreshing: boolean;
  canManage: boolean;
}

/**
 * Admins (Measure page): the Oklahoma counties whose 911 address list is kept for address search. New counties
 * download in the background (a few minutes each) and every county is refreshed every 30 days.
 */
export function AddressCounties() {
  const status = useApi<Status>("/measurements/addresses");
  const action = useAction();
  const [adding, setAdding] = useState("");
  const data = status.data;

  // While downloading, check every 10 seconds.
  useEffect(() => {
    if (!data?.refreshing) return;
    const t = setInterval(() => status.reload(), 10_000);
    return () => clearInterval(t);
  }, [data?.refreshing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <ErrorBox error={status.error} />;
  const chosen = data.counties.map((c) => c.county);
  const setCounties = (counties: string[]) => action.run(async () => status.setData(await api("/measurements/addresses/counties", { method: "PUT", body: { counties } })));

  return (
    <div className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <strong style={{ fontSize: 14 }}>Address search: Oklahoma 911 address list</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        &ldquo;Find a property&rdquo; searches the State of Oklahoma&apos;s 911 address list first: the most complete list,
        with new streets the national databases don&apos;t have yet. These counties are kept here so searching is instant,
        and refreshed every 30 days. Addresses in other Oklahoma counties are still found with Find, just more slowly.
      </span>
      {data.counties.map((c) => (
        <div key={c.county} className="row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap", fontSize: 14 }}>
          <span>
            <strong>{countyLabel(c.county)}</strong>{" "}
            <span className="muted">
              {c.loading ? "downloading…" : c.loadedAt ? `${c.count.toLocaleString()} addresses · updated ${fmtDateTime(c.loadedAt)}` : data.refreshing ? "waiting to download…" : "not downloaded yet"}
            </span>
            {c.error && !c.loading && <span className="error" style={{ display: "block", fontSize: 12 }}>Last download failed: {c.error}</span>}
          </span>
          <button className="btn sm" disabled={action.busy || chosen.length <= 1} onClick={() => setCounties(chosen.filter((x) => x !== c.county))} title="Stop keeping this county">Remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ width: "auto" }} aria-label="County to add">
          <option value="">Add a county…</option>
          {data.all.filter((c) => !chosen.includes(c)).map((c) => <option key={c} value={c}>{countyLabel(c)}</option>)}
        </select>
        <button className="btn sm" disabled={!adding || action.busy} onClick={() => { setCounties([...chosen, adding]); setAdding(""); }}>Add</button>
        <button className="btn sm" disabled={action.busy || data.refreshing} onClick={() => action.run(async () => status.setData(await api("/measurements/addresses/refresh", { method: "POST", body: {} })))}>
          {data.refreshing ? "Downloading…" : "Update Now"}
        </button>
      </div>
      <ErrorBox error={action.error} />
    </div>
  );
}
