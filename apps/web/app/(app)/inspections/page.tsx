"use client";
import { useState } from "react";
import { DEFAULT_INSPECTION_ITEMS } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

const NO_FILTERS = { q: "", asset: "", inspector: "", result: "", item: "", from: "", to: "" };
const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export default function Inspections() {
  const list = useApi<any[]>("/inspections");
  const assets = useApi<any[]>("/assets");
  const [doing, setDoing] = useState(false);
  const { busy, error, run } = useAction();
  const [filters, setFilters] = useState(NO_FILTERS);
  const setFilter = (patch: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = Object.values(filters).some(Boolean);
  const all = list.data ?? [];
  const who = (p: any) => `${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim();
  const q = filters.q.trim().toLowerCase();
  const rows = all.filter(({ inspection: i, assetName, inspector }) =>
    // Search: asset, inspector, defect items and their notes, and the inspection's notes.
    (!q || `${assetName ?? ""} ${who(inspector)} ${i.notes ?? ""} ${i.items.filter((x: any) => !x.ok).map((x: any) => `${x.item} ${x.note ?? ""}`).join(" ")}`.toLowerCase().includes(q)) &&
    (!filters.asset || i.assetId === filters.asset) &&
    (!filters.inspector || i.inspectorId === filters.inspector) &&
    (!filters.result || (filters.result === "passed") === !!i.passed) &&
    (!filters.item || i.items.some((x: any) => x.item === filters.item && !x.ok)) &&
    (!filters.from || ymd(i.createdAt) >= filters.from) &&
    (!filters.to || ymd(i.createdAt) <= filters.to));
  const assetOptions = [...new Map(all.map(({ inspection: i, assetName }) => [i.assetId, assetName ?? "Unknown"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const inspectors = [...new Map(all.filter(({ inspection: i }) => i.inspectorId).map(({ inspection: i, inspector }) => [i.inspectorId, who(inspector) || "Unknown"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const items = [...new Set([...DEFAULT_INSPECTION_ITEMS, ...all.flatMap(({ inspection: i }) => i.items.map((x: any) => x.item))])];

  return (
    <>
      <PageHead title="Inspections" sub={filtering && list.data ? <span role="status">Showing {rows.length} of {all.length} inspections</span> : "Pre-trip and pre-use checks. Failed items open a work order automatically."}>
        <button className="btn primary" onClick={() => setDoing(!doing)}>New inspection</button>
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter inspections" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder="Asset, inspector, defect, notes…" value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        <label>Asset
          <select value={filters.asset} onChange={(e) => setFilter({ asset: e.target.value })}>
            <option value="">All assets</option>
            {assetOptions.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </label>
        <label>Inspector
          <select value={filters.inspector} onChange={(e) => setFilter({ inspector: e.target.value })}>
            <option value="">Anyone</option>
            {inspectors.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </label>
        <label>Result
          <select value={filters.result} onChange={(e) => setFilter({ result: e.target.value })}>
            <option value="">Any</option>
            <option value="passed">Passed ({all.filter(({ inspection: i }) => i.passed).length})</option>
            <option value="failed">Failed ({all.filter(({ inspection: i }) => !i.passed).length})</option>
          </select>
        </label>
        <label>Defect in
          <select value={filters.item} onChange={(e) => setFilter({ item: e.target.value })}>
            <option value="">Any item</option>
            {items.map((it) => <option key={it} value={it}>{it}</option>)}
          </select>
        </label>
        <fieldset className="pay-range date-range">
          <legend>Date</legend>
          <input type="date" aria-label="On or after" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="On or before" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} />
        </fieldset>
        {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </form>
      {doing && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
            const body = {
              assetId: f.get("assetId"),
              odometer: num("odometer"),
              engineHours: num("engineHours"),
              notes: (f.get("notes") as string) || undefined,
              items: DEFAULT_INSPECTION_ITEMS.map((item, i) => ({ item, ok: f.get(`ok-${i}`) !== "fail", note: (f.get(`note-${i}`) as string) || undefined })),
            };
            run(async () => { await api("/inspections", { body }); setDoing(false); list.reload(); });
          }}>
            <div className="formgrid">
              <label>Asset<select name="assetId" required>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>Odometer<input name="odometer" type="number" min="0" /></label>
              <label>Engine hours<input name="engineHours" type="number" min="0" step="0.1" /></label>
            </div>
            <table><tbody>{DEFAULT_INSPECTION_ITEMS.map((item, i) => (
              <tr key={item}>
                <td>{item}</td>
                <td className="row">
                  <label className="check"><input type="radio" name={`ok-${i}`} value="ok" defaultChecked /> OK</label>
                  <label className="check"><input type="radio" name={`ok-${i}`} value="fail" /> Defect</label>
                </td>
                <td><input name={`note-${i}`} placeholder="Note" /></td>
              </tr>
            ))}</tbody></table>
            <label>Notes<textarea name="notes" /></label>
            <ErrorBox error={error} />
            <div><button className="btn primary" disabled={busy}>Submit inspection</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>When</th><th>Asset</th><th>Inspector</th><th>Result</th><th>Defects</th></tr></thead>
            <tbody>{rows.map(({ inspection: i, assetName, inspector }) => (
              <tr key={i.id}>
                <td>{fmtDateTime(i.createdAt)}</td>
                <td>{assetName}</td>
                <td>{inspector?.firstName} {inspector?.lastName}</td>
                <td><Badge value={i.passed ? "passed" : "failed"} /></td>
                <td className="muted">{i.items.filter((x: any) => !x.ok).map((x: any) => x.item + (x.note ? ` (${x.note})` : "")).join(", ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>{all.length ? "No inspections match your filters." : "No inspections yet."}</Empty>}
      </div>
    </>
  );
}
