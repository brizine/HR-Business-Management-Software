"use client";
import { useMemo, useRef, useState } from "react";
import {
  FUEL_TYPES, FUEL_TYPE_LABELS, fuelEconomy, fuelTotals, fuelUnit, totalCostOfOwnership, type FuelType,
} from "@crewdesk/shared";
import { API_URL, ApiError, api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

export type FuelEntry = {
  id: string; date: string; fuelType: FuelType; quantity: number; totalCostCents: number; odometer: number | null; hours: number | null;
  fullTank: boolean; vendor: string | null; notes: string | null; hasReceipt: boolean; createdBy: string | null; createdById: string | null; createdAt: string;
};
type AssetInfo = {
  id: string; name: string; year?: number | null; make?: string | null; model?: string | null; vin?: string | null; licensePlate?: string | null;
  odometer: number; engineHours: number; purchasePriceCents?: number | null; purchaseDate?: string | null; purchaseOdometer?: number | null; purchaseHours?: number | null;
  totalMaintenanceCostCents: number; totalFuelCostCents: number;
};

const NO_FILTERS = { q: "", type: "", from: "", to: "" };
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number, d = 1) => n.toLocaleString(undefined, { maximumFractionDigits: d });
const cents = (c: number | null | undefined, d = 2) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`);

/** Uses miles when the asset has an odometer (or fill-ups with one), otherwise engine hours. */
export function economyMeter(asset: { odometer: number }, entries: { odometer: number | null }[]): "odometer" | "hours" {
  return asset.odometer > 0 || entries.some((e) => e.odometer != null) ? "odometer" : "hours";
}
/** "18.4 MPG" or "2.1 gal/hr" from fuelEconomy's perUnit. */
export function economyText(perUnit: number | null | undefined, meter: "odometer" | "hours") {
  if (!perUnit) return "—";
  return meter === "odometer" ? `${num(perUnit)} MPG` : `${num(1 / perUnit, 2)} gal/hr`;
}

async function openReceipt(id: string) {
  const res = await fetch(`${API_URL}/fuel/${id}/receipt`, { credentials: "include", headers: { "X-Crewdesk-Client": "web" } });
  if (!res.ok) throw new ApiError(res.status, "Couldn't open the receipt");
  window.open(URL.createObjectURL(await res.blob()), "_blank");
}

/** An asset's fuel log: fill-ups with cost, economy, receipts; searchable, CSV and print. */
export function FuelLog({ asset, onChange }: { asset: AssetInfo; onChange: () => void }) {
  const { can, me } = useAuth();
  const manager = can("manager", "fleet");
  const list = useApi<FuelEntry[]>(`/fuel?assetId=${asset.id}`);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [form, setForm] = useState<FuelEntry | "new" | null>(null);
  const remove = useAction();
  const set = (p: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...p }));
  const all = list.data ?? [];
  const meter = economyMeter(asset, all);
  const q = filters.q.trim().toLowerCase();
  const rows = useMemo(() => all.filter((e) =>
    (!q || `${FUEL_TYPE_LABELS[e.fuelType]} ${e.vendor ?? ""} ${e.notes ?? ""} ${e.createdBy ?? ""} ${e.odometer ?? ""}`.toLowerCase().includes(q)) &&
    (!filters.type || e.fuelType === filters.type) && (!filters.from || e.date >= filters.from) && (!filters.to || e.date <= filters.to)), [all, q, filters]);
  const filtering = Object.values(filters).some(Boolean);
  const totals = fuelTotals(rows);
  // Economy over the dates shown (search and type filters don't break up the full-tank stretches).
  const ranged = all.filter((e) => (!filters.from || e.date >= filters.from) && (!filters.to || e.date <= filters.to));
  const econ = fuelEconomy(ranged, meter);
  const perEntry = fuelEconomy(all, meter).byEntry;
  const types = [...new Set(rows.filter((e) => e.fuelType !== "def").map((e) => e.fuelType))];
  const unit = types.length === 1 ? fuelUnit(types[0]) : "gal";
  const mayChange = (e: FuelEntry) => manager || (e.createdById === me?.user.id && Date.now() - Date.parse(e.createdAt) < 24 * 3_600_000);
  const changed = () => { list.reload(); onChange(); };

  const exportCsv = () => {
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Date", "Fuel", "Quantity", "Unit", "Total", "Price per unit", "Odometer", "Engine hours", "Full", meter === "odometer" ? "MPG" : "Gal/hr", "Vendor", "Logged by", "Notes"];
    const body = rows.map((e) => [e.date, FUEL_TYPE_LABELS[e.fuelType], e.quantity, fuelUnit(e.fuelType), (e.totalCostCents / 100).toFixed(2), (e.totalCostCents / 100 / e.quantity).toFixed(3),
      e.odometer ?? "", e.hours ?? "", e.fullTank ? "Yes" : "No", perEntry[e.id] ? (meter === "odometer" ? perEntry[e.id].toFixed(1) : (1 / perEntry[e.id]).toFixed(2)) : "", e.vendor ?? "", e.createdBy ?? "", e.notes ?? ""]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([[head, ...body].map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" }));
    a.download = `${asset.name.replace(/[^\w-]+/g, "-")}-fuel-log.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const print = () => {
    const w = window.open("", "_blank");
    if (!w) return alert("Allow pop-ups to print the fuel log.");
    const vehicle = [asset.year, asset.make, asset.model, asset.licensePlate && `Plate ${asset.licensePlate}`, asset.vin && `VIN ${asset.vin}`].filter(Boolean).join(" · ");
    const tr = rows.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${FUEL_TYPE_LABELS[e.fuelType]}${e.fullTank ? "" : " (partial)"}</td><td class="r">${num(e.quantity, 3)} ${fuelUnit(e.fuelType)}</td><td class="r">${money(e.totalCostCents)}</td><td class="r">${cents(e.totalCostCents / e.quantity, 3)}</td><td>${[e.odometer != null && `${num(e.odometer, 0)} mi`, e.hours != null && `${num(e.hours)} hrs`].filter(Boolean).join(" · ")}</td><td>${perEntry[e.id] ? economyText(perEntry[e.id], meter) : ""}</td><td>${esc([e.vendor, e.createdBy].filter(Boolean).join(" · "))}</td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(asset.name)} fuel log</title><style>
      body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}p{margin:4px 0 14px;color:#444}
      table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}th{font-size:11px;text-transform:uppercase;color:#555}.r{text-align:right}</style></head><body>
      <h1>${esc(asset.name)}: Fuel Log</h1><p>${esc(vehicle)}${filtering ? " · filtered" : ""} · Printed ${new Date().toLocaleDateString()}</p>
      <p><b>${totals.fills} fill-ups · ${num(totals.quantity)} ${unit} · ${money(totals.costCents)}</b> · Avg ${cents(totals.avgPriceCents, 3)}/${unit} · ${economyText(econ.perUnit, meter)}${econ.costPerDistanceCents != null ? ` · ${cents(econ.costPerDistanceCents, 3)} fuel per ${meter === "odometer" ? "mile" : "hour"}` : ""}</p>
      <table><thead><tr><th>Date</th><th>Fuel</th><th class="r">Amount</th><th class="r">Total</th><th class="r">Price</th><th>Meter</th><th>Economy</th><th>Vendor / by</th></tr></thead><tbody>${tr || `<tr><td colspan="8">No fill-ups.</td></tr>`}</tbody></table>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Fuel</h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary sm" onClick={() => setForm(form ? null : "new")}>{form ? "Cancel" : "Log fuel"}</button>
          <button className="btn primary sm" disabled={!rows.length} onClick={exportCsv}>Export CSV</button>
          <button className="btn primary sm" disabled={!rows.length} onClick={print}>Print</button>
        </div>
      </div>
      {form && <FuelForm asset={asset} entry={form === "new" ? undefined : form} onDone={() => { setForm(null); changed(); }} />}
      <div className="stats">
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{money(totals.costCents)}</div><div className="l">Fuel cost{filtering ? " (shown)" : ""}</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{num(totals.quantity)} {unit}</div><div className="l">{totals.fills} fill-up{totals.fills === 1 ? "" : "s"}{totals.defQuantity ? ` · ${num(totals.defQuantity)} gal DEF` : ""}</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{cents(totals.avgPriceCents, 3)}</div><div className="l">Average per {unit}</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{economyText(econ.perUnit, meter)}</div><div className="l">Fuel economy</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{cents(econ.costPerDistanceCents, 3)}</div><div className="l">Fuel per {meter === "odometer" ? "mile" : "engine hour"}</div></div>
      </div>
      <form className="filters" role="search" aria-label="Search fuel log" onSubmit={(e) => e.preventDefault()} style={{ margin: 0 }}>
        <label style={{ width: 260 }}>Search<input type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Station, notes, who logged it…" /></label>
        <label>Fuel
          <select value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">All</option>
            {FUEL_TYPES.map((t) => <option key={t} value={t}>{FUEL_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        {filtering && <button type="button" className="btn sm" onClick={() => setFilters(NO_FILTERS)} style={{ alignSelf: "flex-end" }}>Clear</button>}
      </form>
      <ErrorBox error={list.error || remove.error} />
      {rows.length ? (
        <div className="tablewrap"><table>
          <thead><tr><th>Date</th><th>Fuel</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Price</th><th>Meter</th><th>{meter === "odometer" ? "MPG" : "Gal/hr"}</th><th>Station / logged by</th><th /></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: "nowrap" }}>{fmtDate(e.date)}</td>
              <td>{FUEL_TYPE_LABELS[e.fuelType]}{!e.fullTank && <div className="muted" style={{ fontSize: 12 }}>Partial fill</div>}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{num(e.quantity, 3)} {fuelUnit(e.fuelType)}</td>
              <td style={{ textAlign: "right" }}><strong>{money(e.totalCostCents)}</strong></td>
              <td style={{ textAlign: "right" }} className="muted">{cents(e.totalCostCents / e.quantity, 3)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{[e.odometer != null && `${num(e.odometer, 0)} mi`, e.hours != null && `${num(e.hours)} hrs`].filter(Boolean).join(" · ") || "—"}</td>
              <td>{perEntry[e.id] ? economyText(perEntry[e.id], meter).replace(/ (MPG|gal\/hr)$/, "") : ""}</td>
              <td style={{ maxWidth: 220 }}>{e.vendor ?? ""}{e.vendor && e.createdBy ? <br /> : null}<span className="muted">{e.createdBy ?? ""}</span>{e.notes && <div className="muted" style={{ fontSize: 12 }}>📝 {e.notes}</div>}</td>
              <td className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                {e.hasReceipt && <button className="btn sm" onClick={() => openReceipt(e.id).catch((err) => alert(err.message))}>Receipt</button>}
                {mayChange(e) && <button className="btn sm" onClick={() => setForm(e)}>Edit</button>}
                {mayChange(e) && <button className="btn sm danger" disabled={remove.busy} onClick={() => confirm(`Remove the ${fmtDate(e.date)} fill-up?`) && remove.run(async () => { await api(`/fuel/${e.id}`, { method: "DELETE" }); changed(); })}>×</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : list.data ? <Empty>{filtering ? "No fill-ups match your search." : "No fuel logged yet. Use Log fuel after each fill-up (or from the phone app)."}</Empty> : null}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Fuel economy uses full-tank fill-ups with an odometer (or engine hours) reading: miles since the last full fill ÷ fuel added. DEF isn&apos;t counted as fuel. CNG is measured in GGE.
      </p>
    </div>
  );
}

/** Log or fix a fill-up, with an optional receipt photo/PDF. */
function FuelForm({ asset, entry, onDone }: { asset: AssetInfo; entry?: FuelEntry; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [type, setType] = useState<FuelType>(entry?.fuelType ?? "gasoline");
  const [qty, setQty] = useState(entry ? String(entry.quantity) : "");
  const [total, setTotal] = useState(entry ? (entry.totalCostCents / 100).toFixed(2) : "");
  const [price, setPrice] = useState(entry ? (entry.totalCostCents / 100 / entry.quantity).toFixed(3) : "");
  const file = useRef<HTMLInputElement>(null);
  const u = fuelUnit(type);
  // Enter any two of amount, price and total; the third fills in.
  const onQty = (v: string) => { setQty(v); if (price && v) setTotal((Number(v) * Number(price)).toFixed(2)); else if (total && v) setPrice((Number(total) / Number(v)).toFixed(3)); };
  const onPrice = (v: string) => { setPrice(v); if (qty && v) setTotal((Number(qty) * Number(v)).toFixed(2)); };
  const onTotal = (v: string) => { setTotal(v); if (qty && v) setPrice((Number(v) / Number(qty)).toFixed(3)); };

  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const s = (k: string) => ((f.get(k) as string) ?? "").trim();
      const n = (k: string) => (s(k) === "" ? null : Number(s(k)));
      run(async () => {
        const body = {
          date: s("date"), fuelType: type, quantity: Number(qty), totalCostCents: Math.round(Number(total) * 100),
          odometer: n("odometer"), hours: n("hours"), fullTank: f.get("fullTank") === "on", vendor: s("vendor") || undefined, notes: s("notes") || undefined,
        };
        const saved = entry
          ? await api<FuelEntry>(`/fuel/${entry.id}`, { method: "PUT", body })
          : await api<FuelEntry>("/fuel", { body: { ...body, assetId: asset.id } });
        const receipt = file.current?.files?.[0];
        if (receipt) {
          const fd = new FormData();
          fd.append("file", receipt);
          await api(`/fuel/${saved.id}/receipt`, { body: fd });
        }
        onDone();
      });
    }}>
      <div className="formgrid">
        <label>Date<input name="date" type="date" required max={todayYmd()} defaultValue={entry?.date ?? todayYmd()} /></label>
        <label>Fuel
          <select value={type} onChange={(e) => setType(e.target.value as FuelType)}>
            {FUEL_TYPES.map((t) => <option key={t} value={t}>{FUEL_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label>Amount ({u === "GGE" ? "GGE" : "gallons"})<input type="number" min="0.001" step="0.001" required value={qty} onChange={(e) => onQty(e.target.value)} /></label>
        <label>Price per {u}($)<input type="number" min="0" step="0.001" value={price} onChange={(e) => onPrice(e.target.value)} /></label>
        <label>Total ($)<input type="number" min="0" step="0.01" required value={total} onChange={(e) => onTotal(e.target.value)} /></label>
        <label>Odometer (mi)<input name="odometer" type="number" min="0" defaultValue={entry?.odometer ?? ""} placeholder={asset.odometer ? String(asset.odometer) : ""} /></label>
        <label>Engine hours<input name="hours" type="number" min="0" step="0.1" defaultValue={entry?.hours ?? ""} placeholder={asset.engineHours ? String(asset.engineHours) : ""} /></label>
        <label>Station / vendor<input name="vendor" maxLength={200} defaultValue={entry?.vendor ?? ""} /></label>
        <label>Receipt (photo or PDF)<input ref={file} type="file" accept="image/*,application/pdf" /></label>
      </div>
      <label className="check"><input name="fullTank" type="checkbox" defaultChecked={entry?.fullTank ?? true} /> Filled to full (needed for fuel economy)</label>
      <label>Notes<input name="notes" maxLength={1000} defaultValue={entry?.notes ?? ""} /></label>
      {type === "cng" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>CNG pumps show gasoline gallon equivalents (GGE); enter that number.</p>}
      <ErrorBox error={error} />
      <div><button className="btn primary" disabled={busy}>{entry ? "Save changes" : "Save fill-up"}</button></div>
    </form>
  );
}

/** Purchase + maintenance + fuel, and per mile / hour / year since purchase. */
export function TotalCostOfOwnership({ asset }: { asset: AssetInfo }) {
  const t = totalCostOfOwnership({
    purchasePriceCents: asset.purchasePriceCents ?? null, purchaseDate: asset.purchaseDate ?? null, purchaseOdometer: asset.purchaseOdometer ?? null, purchaseHours: asset.purchaseHours ?? null,
    odometer: asset.odometer, engineHours: asset.engineHours, maintenanceCents: asset.totalMaintenanceCostCents, fuelCents: asset.totalFuelCostCents,
  });
  const usesMiles = asset.odometer > 0;
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Total Cost of Ownership</h2>
      <div className="stats">
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{asset.purchasePriceCents != null ? money(asset.purchasePriceCents) : "—"}</div><div className="l">Purchase price{asset.purchaseDate ? ` (${fmtDate(asset.purchaseDate)})` : ""}</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{money(asset.totalMaintenanceCostCents)}</div><div className="l">Maintenance</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{money(asset.totalFuelCostCents)}</div><div className="l">Fuel</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{money(t.totalCents)}</div><div className="l">Total</div></div>
        {usesMiles ? (
          <div className="stat"><div className="v" style={{ fontSize: 18 }}>{cents(t.perMileCents, 3)}</div><div className="l">Per mile ({num(t.miles, 0)} mi){t.operatingPerMileCents != null && asset.purchasePriceCents ? ` · ${cents(t.operatingPerMileCents, 3)} to run` : ""}</div></div>
        ) : (
          <div className="stat"><div className="v" style={{ fontSize: 18 }}>{cents(t.perHourCents)}</div><div className="l">Per engine hour ({num(t.hours)} hrs){t.operatingPerHourCents != null && asset.purchasePriceCents ? ` · ${cents(t.operatingPerHourCents)} to run` : ""}</div></div>
        )}
        <div className="stat"><div className="v" style={{ fontSize: 18 }}>{cents(t.perYearCents, 0)}</div><div className="l">Per year owned{t.years ? ` (${num(t.years)} yrs)` : ""}</div></div>
      </div>
      {(asset.purchasePriceCents == null || !asset.purchaseDate) && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Add the purchase price, date and {usesMiles ? "odometer" : "engine hours"} at purchase (Edit, at the top of this page) for the full picture.</p>
      )}
    </div>
  );
}
