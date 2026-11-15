"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Entry = {
  id: string; number: number; title: string; description: string | null; completedAt: string | null;
  odometer: number | null; hours: number | null; vendor: string | null; doneBy: string | null; laborHours: number | null;
  partsCostCents: number; laborCostCents: number; notes: string | null; kind: "scheduled" | "repair" | "inspection"; scheduleName: string | null;
};
type AssetInfo = { id: string; name: string; year?: number | null; make?: string | null; model?: string | null; vin?: string | null; licensePlate?: string | null; schedules: { id: string; name: string }[] };

const KIND_LABEL: Record<Entry["kind"], string> = { scheduled: "Scheduled service", repair: "Repair", inspection: "From inspection" };
const NO_FILTERS = { q: "", kind: "", from: "", to: "" };
const ymd = (iso: string | null) => (iso ? (() => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })() : "");
const meters = (e: Entry) => [e.odometer != null && `${e.odometer.toLocaleString()} mi`, e.hours != null && `${e.hours.toLocaleString()} hrs`].filter(Boolean).join(" · ");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Every completed service and repair for an asset: searchable, with totals, CSV and print. */
export function MaintenanceHistory({ asset, onChange }: { asset: AssetInfo; onChange: () => void }) {
  const { can } = useAuth();
  const manager = can("manager", "fleet");
  const list = useApi<Entry[]>(`/assets/${asset.id}/history`);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [adding, setAdding] = useState(false);
  const set = (p: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...p }));
  const all = list.data ?? [];
  const q = filters.q.trim().toLowerCase();
  const rows = useMemo(() => all.filter((e) => {
    const day = ymd(e.completedAt);
    return (!q || `#${e.number} ${e.number} ${e.title} ${e.description ?? ""} ${e.notes ?? ""} ${e.vendor ?? ""} ${e.doneBy ?? ""} ${e.scheduleName ?? ""} ${meters(e)}`.toLowerCase().includes(q)) &&
      (!filters.kind || e.kind === filters.kind) && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
  }), [all, q, filters]);
  const filtering = Object.values(filters).some(Boolean);
  const parts = rows.reduce((t, e) => t + e.partsCostCents, 0);
  const labor = rows.reduce((t, e) => t + e.laborCostCents, 0);
  const vehicle = [asset.year, asset.make, asset.model].filter(Boolean).join(" ");

  const exportCsv = () => {
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Date", "Work order", "Type", "Service", "Odometer (mi)", "Engine hours", "Done by", "Vendor", "Labor hours", "Parts", "Labor", "Total", "Description", "Notes"];
    const body = rows.map((e) => [ymd(e.completedAt), e.number, KIND_LABEL[e.kind], e.title, e.odometer ?? "", e.hours ?? "", e.doneBy ?? "", e.vendor ?? "", e.laborHours ?? "",
      (e.partsCostCents / 100).toFixed(2), (e.laborCostCents / 100).toFixed(2), ((e.partsCostCents + e.laborCostCents) / 100).toFixed(2), e.description ?? "", e.notes ?? ""]);
    const csv = [head, ...body].map((r) => r.map(cell).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${asset.name.replace(/[^\w-]+/g, "-")}-maintenance-history.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const print = () => {
    const w = window.open("", "_blank");
    if (!w) return alert("Allow pop-ups to print the history.");
    const tr = rows.map((e) => `<tr><td>${fmtDate(e.completedAt)}</td><td>#${e.number}</td><td><b>${esc(e.title)}</b>${e.notes || e.description ? `<div class="m">${esc(e.notes || e.description || "")}</div>` : ""}</td><td>${esc(meters(e))}</td><td>${esc([e.doneBy, e.vendor].filter(Boolean).join(" · "))}</td><td class="r">${money(e.partsCostCents)}</td><td class="r">${money(e.laborCostCents)}</td><td class="r"><b>${money(e.partsCostCents + e.laborCostCents)}</b></td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(asset.name)} maintenance history</title><style>
      body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}p{margin:4px 0 14px;color:#444}
      table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#555}
      .r{text-align:right}.m{color:#555;font-size:12px;white-space:pre-wrap}tfoot td{font-weight:bold;border-top:2px solid #111}</style></head><body>
      <h1>${esc(asset.name)}: Maintenance History</h1>
      <p>${esc([vehicle, asset.licensePlate && `Plate ${asset.licensePlate}`, asset.vin && `VIN ${asset.vin}`].filter(Boolean).join(" · "))}${filtering ? " · filtered" : ""} · Printed ${new Date().toLocaleDateString()}</p>
      <table><thead><tr><th>Date</th><th>WO</th><th>Service</th><th>Mileage / hours</th><th>Done by / vendor</th><th class="r">Parts</th><th class="r">Labor</th><th class="r">Total</th></tr></thead>
      <tbody>${tr || `<tr><td colspan="8">No services.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="5">${rows.length} service${rows.length === 1 ? "" : "s"}</td><td class="r">${money(parts)}</td><td class="r">${money(labor)}</td><td class="r">${money(parts + labor)}</td></tr></tfoot></table>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Maintenance History</h2>
        <div className="row" style={{ gap: 8 }}>
          {manager && <button className="btn primary sm" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add past service"}</button>}
          <button className="btn primary sm" disabled={!rows.length} onClick={exportCsv}>Export CSV</button>
          <button className="btn primary sm" disabled={!rows.length} onClick={print}>Print</button>
        </div>
      </div>
      {adding && <PastServiceForm asset={asset} onDone={() => { setAdding(false); list.reload(); onChange(); }} />}
      <form className="filters" role="search" aria-label="Search maintenance history" onSubmit={(e) => e.preventDefault()} style={{ margin: 0 }}>
        <label style={{ width: 300 }}>Search<input type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Service, part, vendor, notes, WO #, who did it…" /></label>
        <label>Type
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">All</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        {filtering && <button type="button" className="btn sm" onClick={() => setFilters(NO_FILTERS)} style={{ alignSelf: "flex-end" }}>Clear</button>}
      </form>
      <ErrorBox error={list.error} />
      {list.data && (
        <span className="muted" role="status" style={{ fontSize: 14 }}>
          {filtering ? `Showing ${rows.length} of ${all.length}` : `${all.length}`} service{(filtering ? all.length : rows.length) === 1 ? "" : "s"} · Parts {money(parts)} · Labor {money(labor)} · <strong>Total {money(parts + labor)}</strong>
        </span>
      )}
      {rows.length ? (
        <div className="tablewrap"><table>
          <thead><tr><th>Date</th><th>Work order</th><th>Service</th><th>Mileage / hours</th><th>Done by / vendor</th><th style={{ textAlign: "right" }}>Parts</th><th style={{ textAlign: "right" }}>Labor</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: "nowrap" }}>{fmtDate(e.completedAt)}</td>
              <td><Link href={`/work-orders?highlight=${e.id}`}>#{e.number}</Link><div className="muted" style={{ fontSize: 12 }}>{KIND_LABEL[e.kind]}</div></td>
              <td style={{ maxWidth: 320 }}>
                <strong>{e.title}</strong>
                {e.description && e.description !== e.notes && <div className="muted" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{e.description}</div>}
                {e.notes && <div className="muted" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>📝 {e.notes}</div>}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>{meters(e) || "—"}</td>
              <td>{e.doneBy ?? ""}{e.doneBy && e.vendor ? <br /> : null}{e.vendor ? <span className="muted">{e.vendor}</span> : null}{!e.doneBy && !e.vendor ? "—" : null}</td>
              <td style={{ textAlign: "right" }}>{money(e.partsCostCents)}</td>
              <td style={{ textAlign: "right" }}>{money(e.laborCostCents)}{e.laborHours ? <div className="muted" style={{ fontSize: 12 }}>{e.laborHours} hrs</div> : null}</td>
              <td style={{ textAlign: "right" }}><strong>{money(e.partsCostCents + e.laborCostCents)}</strong></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : list.data ? (
        <Empty>{filtering ? "Nothing matches your search." : "No completed maintenance yet. Completed work orders appear here; use Add past service for older records."}</Empty>
      ) : null}
    </div>
  );
}

/** Record a service done before (e.g. from paper records or a receipt). */
function PastServiceForm({ asset, onDone }: { asset: AssetInfo; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const today = ymd(new Date().toISOString());
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const s = (k: string) => ((f.get(k) as string) ?? "").trim();
      const n = (k: string) => (s(k) === "" ? null : Number(s(k)));
      run(async () => {
        await api("/work-orders/past", { body: {
          assetId: asset.id, title: s("title"), date: s("date"), scheduleId: s("scheduleId") || null,
          odometer: n("odometer"), hours: n("hours"), vendor: s("vendor") || undefined, laborHours: n("laborHours"),
          partsCostCents: Math.round((n("parts") ?? 0) * 100), laborCostCents: Math.round((n("labor") ?? 0) * 100), notes: s("notes") || undefined,
        } });
        onDone();
      });
    }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Add a service done before, e.g. from paper records or a receipt. If it&apos;s for one of this asset&apos;s schedules and newer than its last service, the schedule counts from it.</p>
      <div className="formgrid">
        <label>What was done<input name="title" required maxLength={200} placeholder="e.g. Front brake pads" /></label>
        <label>Date<input name="date" type="date" required max={today} defaultValue={today} /></label>
        <label>Odometer (mi)<input name="odometer" type="number" min="0" /></label>
        <label>Engine hours<input name="hours" type="number" min="0" step="0.1" /></label>
        <label>Vendor / shop<input name="vendor" maxLength={200} /></label>
        <label>Parts ($)<input name="parts" type="number" min="0" step="0.01" /></label>
        <label>Labor ($)<input name="labor" type="number" min="0" step="0.01" /></label>
        <label>Labor hours<input name="laborHours" type="number" min="0" step="0.25" /></label>
        {asset.schedules.length > 0 && (
          <label>For schedule
            <select name="scheduleId" defaultValue="">
              <option value="">None (repair or other)</option>
              {asset.schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <label>Notes<textarea name="notes" rows={2} maxLength={4000} placeholder="Parts used, what was found…" /></label>
      <ErrorBox error={error} />
      <div><button className="btn primary" disabled={busy}>Save to history</button></div>
    </form>
  );
}
