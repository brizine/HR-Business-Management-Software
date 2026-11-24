"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "leaflet/dist/leaflet.css";
import {
  BACK_REASONS, BACK_REASON_LABELS, BADGE_HINTS, BADGE_LABELS, NOTIFY_BEFORE, NOTIFY_BEFORE_LABELS, PRIORITIES, PRIORITY_LABELS,
  formatMoney, visitNumber, type NotifyBefore, type Priority, type WaitBadge,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Popover, readLocal, writeLocal } from "./customer-list";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

/* ───────────── Data ───────────── */

export type WaitRow = {
  id: string; number: number; title: string; status: string; date: string | null; priority: Priority; releaseOn: string | null; dueBy: string | null; minDaysAfterLast: number | null;
  eligible: string | null; lastServiceOn: string | null; waitingDays: number; windowStart: string | null; windowEnd: string | null; backReason: string | null;
  estMinutes: number | null; estSource: "set" | "history" | "size" | "none"; estUsed: number; estLeftOut: number; totalCents: number; crewId: string | null; preferredCrewId: string | null;
  service: { id: string | null; name: string }; serviceTypeIds: string[]; tagIds: string[];
  customer: { id: string; name: string; notifyBefore: NotifyBefore; tagIds: string[] };
  property: { id: string; address: string; street: string; city: string | null; zip: string | null; lat: number | null; lng: number | null; mapCode: string | null; sqFt: number | null; pets: string | null; tagIds: string[] };
  needsCard: boolean; badges: WaitBadge[];
};
export type Crew = { id: string; name: string; color: string; dailyHours: number };
export type WaitData = { today: string; requireCard: boolean; rows: WaitRow[]; crews: Crew[] };
type Workload = { dates: string[]; holidays: Record<string, string>; crews: { id: string | null; name: string; color: string; dailyHours: number | null; days: { count: number; hours: number }[] }[] };
export type Filter = { key: string; value: string };
export type WaitView = { id?: string; name: string; shared?: boolean; mine?: boolean; filters: Filter[]; columns: string[]; sort: { key: string; dir: "asc" | "desc" } | null };

export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
const shortDay = (d: string | null) => (d ? dayLabel(d, { month: "short", day: "numeric" }) : "");
const hoursText = (min: number | null) => (min == null ? "" : (min / 60).toFixed(1));
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; };
export const windowText = (s: string | null, e: string | null) => (!s ? "" : e ? `${time12(s)}–${time12(e)}` : `After ${time12(s)}`);
const sum = (rs: WaitRow[], f: (r: WaitRow) => number | null) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
export const totalsOf = (rs: WaitRow[]) => ({ count: rs.length, minutes: sum(rs, (r) => r.estMinutes), sqFt: sum(rs, (r) => r.property.sqFt), cents: sum(rs, (r) => r.totalCents) });
const totalsText = (t: ReturnType<typeof totalsOf>) => `${t.count} work order${t.count === 1 ? "" : "s"} · ${hoursText(t.minutes)} h · ${Math.round(t.sqFt).toLocaleString()} sq ft · ${formatMoney(t.cents)}`;

/** Distinct pin colors, one per service. */
const PALETTE = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#65a30d", "#0d9488", "#7c3aed", "#b45309"];
export function serviceColors(rows: WaitRow[]) {
  const names = [...new Map(rows.map((r) => [r.service.id ?? `name:${r.service.name}`, r.service.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return new Map(names.map(([k], i) => [k, PALETTE[i % PALETTE.length]]));
}
const serviceKey = (r: WaitRow) => r.service.id ?? `name:${r.service.name}`;

/** Miles between two points (great circle). */
function miles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export function Badges({ badges }: { badges: WaitBadge[] }) {
  if (!badges.length) return null;
  return <span className="wl-badges">{badges.map((b) => <span key={b} className={`wl-badge wl-b-${b}`} title={BADGE_HINTS[b]}>{BADGE_LABELS[b]}</span>)}</span>;
}

/** Estimated hours, and where they came from (hover). */
function EstHours({ r }: { r: WaitRow }) {
  if (r.estMinutes == null) return <span className="muted" title="No estimate yet: set setup and per-1,000 sq ft minutes on the service in the price list, or give the work order budgeted hours">—</span>;
  const h = hoursText(r.estMinutes);
  if (r.estSource === "set") return <span title="Set on the work order (budgeted hours)">{h} <span aria-label="set by the office">🔒</span></span>;
  if (r.estSource === "size") return <span title="Estimated from the lawn size and the service's minutes per 1,000 sq ft">~{h}</span>;
  return (
    <span title={`From this property's last ${r.estUsed} visit${r.estUsed === 1 ? "" : "s"} of this service${r.estUsed < 3 ? ", blended with the size estimate" : ""}${r.estLeftOut ? `; ${r.estLeftOut} left out as far off the usual` : ""}`}>
      {h}{r.estLeftOut ? <span className="wl-flag" aria-label="Some visits were left out"> !</span> : null}
    </span>
  );
}

/* ───────────── Filters ───────────── */

export const FILTER_KINDS: { key: string; label: string }[] = [
  { key: "service", label: "Service" }, { key: "mc", label: "Map Code starts with" }, { key: "city", label: "City" }, { key: "zip", label: "ZIP" },
  { key: "priority", label: "Priority" }, { key: "badge", label: "Badge" }, { key: "crew", label: "Preferred crew" }, { key: "near", label: "Within miles of a property" },
  { key: "due", label: "Due by on or before" }, { key: "eligible", label: "Eligible by" },
];

export function describeFilter(f: Filter, ctx: { services: Map<string, string>; crews: Crew[] }) {
  switch (f.key) {
    case "q": return `Search: ${f.value}`;
    case "service": return `Service: ${ctx.services.get(f.value) ?? "a removed service"}`;
    case "mc": return `MC starts with ${f.value}`;
    case "city": return `City: ${f.value}`;
    case "zip": return `ZIP: ${f.value}`;
    case "priority": return `Priority: ${PRIORITY_LABELS[f.value as Priority] ?? f.value}`;
    case "badge": return BADGE_LABELS[f.value as WaitBadge] ?? f.value;
    case "crew": return f.value === "none" ? "No preferred crew" : `Preferred crew: ${ctx.crews.find((c) => c.id === f.value)?.name ?? "a removed crew"}`;
    case "near": { const [, , mi, ...label] = f.value.split(","); return `Within ${mi} mi of ${label.join(",")}`; }
    case "due": return `Due by ${shortDay(f.value)} or sooner`;
    case "eligible": return `Eligible by ${shortDay(f.value)}`;
    case "upcoming": return "Including ones not released yet";
    default: return `${f.key}: ${f.value}`;
  }
}

function matches(r: WaitRow, f: Filter): boolean {
  const v = f.value.trim().toLowerCase();
  switch (f.key) {
    case "q": return `${r.customer.name} ${r.property.address} ${r.title} ${r.service.name} ${visitNumber(r.number)}`.toLowerCase().includes(v);
    case "service": return r.serviceTypeIds.includes(f.value) || serviceKey(r) === f.value;
    case "mc": return (r.property.mapCode ?? "").toLowerCase().startsWith(v);
    case "city": return (r.property.city ?? "").toLowerCase() === v;
    case "zip": return (r.property.zip ?? "").startsWith(v);
    case "priority": return r.priority === f.value;
    case "badge": return r.badges.includes(f.value as WaitBadge);
    case "crew": return f.value === "none" ? !r.preferredCrewId : r.preferredCrewId === f.value;
    case "near": {
      const [lat, lng, mi] = f.value.split(",").map(Number);
      return r.property.lat != null && r.property.lng != null && miles({ lat, lng }, { lat: r.property.lat, lng: r.property.lng }) <= mi;
    }
    case "due": return !!r.dueBy && r.dueBy <= f.value;
    case "eligible": return !r.eligible || r.eligible <= f.value;
    default: return true;
  }
}
/** Every kind of filter must match; several of one kind match any of them (Round 3 or Round 4). */
export function applyFilters(rows: WaitRow[], filters: Filter[]) {
  const groups = new Map<string, Filter[]>();
  for (const f of filters) if (f.key !== "upcoming") groups.set(f.key, [...(groups.get(f.key) ?? []), f]);
  return rows.filter((r) => [...groups.values()].every((fs) => fs.some((f) => matches(r, f))));
}

/** Adds one filter: pick the kind, then its value (choices come from what's on the list). */
export function AddFilter({ rows, crews, onAdd }: { rows: WaitRow[]; crews: Crew[]; onAdd: (f: Filter) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("service");
  const [value, setValue] = useState("");
  const [mi, setMi] = useState("2");
  const opts = useMemo(() => {
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return {
      service: [...new Map(rows.map((r) => [serviceKey(r), r.service.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
      city: uniq(rows.map((r) => r.property.city)),
      near: rows.filter((r) => r.property.lat != null).map((r) => [r.property.id, r.property.street, r.property.lat, r.property.lng] as const).filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i).sort((a, b) => a[1].localeCompare(b[1])),
    };
  }, [rows]);
  const add = () => {
    let v = value.trim();
    if (key === "near") { const p = opts.near.find((x) => x[0] === value); if (!p || !(Number(mi) > 0)) return; v = `${p[2]},${p[3]},${Number(mi)},${p[1]}`; }
    if (!v) return;
    onAdd({ key, value: v });
    setValue(""); setOpen(false);
  };
  let input: ReactNode;
  switch (key) {
    case "service": input = <select aria-label="Service" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick a service</option>{opts.service.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>; break;
    case "city": input = <select aria-label="City" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick a city</option>{opts.city.map((c) => <option key={c} value={c}>{c}</option>)}</select>; break;
    case "priority": input = <select aria-label="Priority" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select>; break;
    case "badge": input = <select aria-label="Badge" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick a badge</option>{(Object.keys(BADGE_LABELS) as WaitBadge[]).map((b) => <option key={b} value={b}>{BADGE_LABELS[b]}</option>)}</select>; break;
    case "crew": input = <select aria-label="Crew" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick</option><option value="none">No preferred crew</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>; break;
    case "near": input = (
      <div className="row cl-between">
        <input aria-label="Miles" inputMode="decimal" value={mi} onChange={(e) => setMi(e.target.value)} style={{ width: 70 }} /> mi of
        <select aria-label="Property" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick a property</option>{opts.near.map((p) => <option key={p[0]} value={p[0]}>{p[1]}</option>)}</select>
      </div>
    ); break;
    case "due": case "eligible": input = <input aria-label="Date" type="date" value={value} onChange={(e) => setValue(e.target.value)} />; break;
    default: input = <input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={key === "mc" ? "e.g. 80 (matches 801, 802…)" : ""} />;
  }
  return (
    <Popover open={open} setOpen={setOpen} label={<><Icon name="sliders" size={14} /> Filter</>} className="cl-pop-wide">
      <form className="stack cl-editor" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <select aria-label="Filter by" value={key} onChange={(e) => { setKey(e.target.value); setValue(""); }}>
          {FILTER_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
        {input}
        <div className="row"><button className="btn primary">Apply filter</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Popover>
  );
}

/* ───────────── Columns ───────────── */

type WCol = { key: string; label: string; group: string; num?: boolean; sort?: (r: WaitRow) => string | number | null; text: (r: WaitRow, crews: Crew[]) => string; cell?: (r: WaitRow, crews: Crew[]) => ReactNode };
const crewName = (id: string | null, crews: Crew[]) => (id ? crews.find((c) => c.id === id)?.name ?? "" : "");
export const WL_COLUMNS: WCol[] = [
  { key: "property", label: "Property", group: "Property", sort: (r) => r.property.street.toLowerCase(), text: (r) => r.property.address,
    cell: (r) => <><Link href={`/properties/${r.property.id}`}><strong>{r.property.street}</strong></Link><div className="muted wl-sub"><Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link>{r.property.city ? ` · ${r.property.city}` : ""}</div></> },
  { key: "service", label: "Service", group: "Work", sort: (r) => r.service.name.toLowerCase(), text: (r) => r.service.name, cell: (r) => <Link href={`/visits/${r.id}`}>{r.service.name}</Link> },
  { key: "mc", label: "MC", group: "Property", sort: (r) => r.property.mapCode, text: (r) => r.property.mapCode ?? "" },
  { key: "eligible", label: "Eligible from", group: "Window", sort: (r) => r.eligible ?? "", text: (r) => shortDay(r.eligible) },
  { key: "due", label: "Due by", group: "Window", sort: (r) => r.dueBy ?? "9999", text: (r) => shortDay(r.dueBy) },
  { key: "est", label: "Est. hours", group: "Work", num: true, sort: (r) => r.estMinutes, text: (r) => hoursText(r.estMinutes), cell: (r) => <EstHours r={r} /> },
  { key: "sqft", label: "Sq ft", group: "Property", num: true, sort: (r) => r.property.sqFt, text: (r) => (r.property.sqFt ? Math.round(r.property.sqFt).toLocaleString() : "") },
  { key: "price", label: "Price", group: "Work", num: true, sort: (r) => r.totalCents, text: (r) => (r.totalCents ? formatMoney(r.totalCents) : "") },
  { key: "badges", label: "Badges", group: "Window", sort: (r) => r.badges.length, text: (r) => r.badges.map((b) => BADGE_LABELS[b]).join("; "), cell: (r) => <Badges badges={r.badges} /> },
  { key: "customer", label: "Customer", group: "Customer", sort: (r) => r.customer.name.toLowerCase(), text: (r) => r.customer.name, cell: (r) => <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> },
  { key: "number", label: "Work order", group: "Work", sort: (r) => r.number, text: (r) => visitNumber(r.number), cell: (r) => <Link href={`/visits/${r.id}`}>{visitNumber(r.number)}</Link> },
  { key: "title", label: "Title", group: "Work", sort: (r) => r.title.toLowerCase(), text: (r) => r.title },
  { key: "priority", label: "Priority", group: "Window", sort: (r) => PRIORITIES.indexOf(r.priority), text: (r) => PRIORITY_LABELS[r.priority] },
  { key: "waited", label: "Waiting (days)", group: "Window", num: true, sort: (r) => r.waitingDays, text: (r) => String(r.waitingDays) },
  { key: "released", label: "Released", group: "Window", sort: (r) => r.releaseOn ?? "", text: (r) => shortDay(r.releaseOn) },
  { key: "minDays", label: "Min. days since last", group: "Window", num: true, sort: (r) => r.minDaysAfterLast, text: (r) => (r.minDaysAfterLast ? String(r.minDaysAfterLast) : "") },
  { key: "last", label: "Last service", group: "Property", sort: (r) => r.lastServiceOn ?? "", text: (r) => shortDay(r.lastServiceOn) },
  { key: "window", label: "Appointment window", group: "Window", sort: (r) => r.windowStart ?? "", text: (r) => windowText(r.windowStart, r.windowEnd) },
  { key: "city", label: "City", group: "Property", sort: (r) => r.property.city ?? "", text: (r) => r.property.city ?? "" },
  { key: "zip", label: "ZIP", group: "Property", sort: (r) => r.property.zip ?? "", text: (r) => r.property.zip ?? "" },
  { key: "crew", label: "Preferred crew", group: "Property", sort: (r) => r.preferredCrewId ?? "", text: (r, c) => crewName(r.preferredCrewId, c) },
  { key: "notify", label: "Notice before", group: "Customer", text: (r) => { const b = r.badges.find((x) => x === "text_ahead" || x === "call_ahead"); return b ? BADGE_LABELS[b] : ""; } },
  { key: "pets", label: "Pets", group: "Property", text: (r) => r.property.pets ?? "" },
  { key: "back", label: "Back on the list because", group: "Window", text: (r) => r.backReason ?? "" },
];
export const DEFAULT_WL_COLUMNS = ["property", "service", "mc", "eligible", "due", "est", "sqft", "price", "badges"];
const colByKey = new Map(WL_COLUMNS.map((c) => [c.key, c]));

export function sortRows(rows: WaitRow[], sort: WaitView["sort"]) {
  const col = sort ? colByKey.get(sort.key) : undefined;
  const key = col?.sort ?? ((r: WaitRow) => r.dueBy ?? "9999");
  const dir = sort?.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c * dir || (a.eligible ?? "").localeCompare(b.eligible ?? "");
  });
}

/** Columns: the shown ones in order (Property always first), then the rest to add. */
export function Columns({ shown, onChange }: { shown: string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const rest = WL_COLUMNS.filter((c) => !shown.includes(c.key));
  const move = (i: number, d: -1 | 1) => { const n = [...shown]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  return (
    <Popover open={open} setOpen={setOpen} label={<><Icon name="list" size={14} /> Columns</>} className="cl-pop-wide" align="right">
      <div className="stack cl-columns">
        <div className="row" style={{ justifyContent: "space-between" }}><strong>Shown, in order</strong><button type="button" className="linkbtn" onClick={() => onChange(DEFAULT_WL_COLUMNS)}>Reset</button></div>
        <ol className="cl-shown">
          {shown.map((k, i) => (
            <li key={k}>
              <span>{colByKey.get(k)?.label}</span>
              {k !== "property" && (
                <span className="row" style={{ gap: 2 }}>
                  <button type="button" className="btn" aria-label={`Move ${colByKey.get(k)?.label} up`} disabled={i <= 1} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn" aria-label={`Move ${colByKey.get(k)?.label} down`} disabled={i === shown.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="btn" aria-label={`Hide ${colByKey.get(k)?.label}`} onClick={() => onChange(shown.filter((x) => x !== k))}>✕</button>
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="cl-addcols">
          {rest.map((c) => <button key={c.key} type="button" className="cl-addcol" onClick={() => onChange([...shown, c.key])}><Icon name="plus" size={12} /> {c.label}</button>)}
          {!rest.length && <p className="muted" style={{ margin: 0 }}>Every column is shown.</p>}
        </div>
      </div>
    </Popover>
  );
}

/* ───────────── Map ───────────── */

type MapPrefs = { height: number; collapsed: boolean };
/**
 * A pin per service (colored by service, red ring when its window is closing or missed), grouped
 * into numbered circles when close together. Click pins to select; "Draw a box" selects an area.
 */
export function WaitMap({ rows, colors, selected, onToggle, onSelect, fitKey, unmapped }: {
  rows: WaitRow[]; colors: Map<string, string>; selected: Set<string>; onToggle: (ids: string[]) => void; onSelect: (ids: string[]) => void; fitKey: string; unmapped: number;
}) {
  const [prefs, setPrefs] = useState<MapPrefs>(() => readLocal("wl-map", { height: 0, collapsed: false }));
  const [full, setFull] = useState(false);
  const [boxMode, setBoxMode] = useState(false);
  const [zoom, setZoom] = useState(0);
  const el = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const L = useRef<typeof import("leaflet") | null>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const layer = useRef<import("leaflet").LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const save = (p: MapPrefs) => { setPrefs(p); writeLocal("wl-map", p); };
  const height = prefs.height || (typeof window !== "undefined" ? Math.max(280, Math.round(window.innerHeight * 0.45)) : 400);
  const mapped = rows.filter((r) => r.property.lat != null && r.property.lng != null);

  // The map itself (made once while shown).
  useEffect(() => {
    if (prefs.collapsed || !el.current) return;
    let cancelled = false;
    import("leaflet").then((Lf) => {
      if (cancelled || !el.current) return;
      L.current = Lf;
      const m = Lf.map(el.current, { boxZoom: false, zoomControl: true });
      Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(m);
      m.setView([35.22, -97.44], 11);
      layer.current = Lf.layerGroup().addTo(m);
      m.on("zoomend", () => setZoom(m.getZoom()));
      map.current = m;
      setReady(true);
      setZoom(m.getZoom());
    });
    return () => { cancelled = true; map.current?.remove(); map.current = null; layer.current = null; setReady(false); };
  }, [prefs.collapsed]);

  // Zoom to what's on the list when the filters change.
  useEffect(() => {
    const m = map.current, Lf = L.current;
    if (!ready || !m || !Lf || !mapped.length) return;
    const b = Lf.latLngBounds(mapped.map((r) => [r.property.lat!, r.property.lng!] as [number, number]));
    if (mapped.length === 1) m.setView(b.getCenter(), 16); else m.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey]);

  // Pins and groups, redrawn when the rows, selection or zoom change.
  useEffect(() => {
    const m = map.current, Lf = L.current, g = layer.current;
    if (!ready || !m || !Lf || !g) return;
    g.clearLayers();
    const z = m.getZoom();
    const cells = new Map<string, WaitRow[]>();
    for (const r of mapped) {
      const p = m.project([r.property.lat!, r.property.lng!], z);
      const k = z >= 17 ? `${r.property.lat},${r.property.lng}` : `${Math.floor(p.x / 48)}:${Math.floor(p.y / 48)}`;
      cells.set(k, [...(cells.get(k) ?? []), r]);
    }
    for (const rs of cells.values()) {
      const lat = rs.reduce((a, r) => a + r.property.lat!, 0) / rs.length;
      const lng = rs.reduce((a, r) => a + r.property.lng!, 0) / rs.length;
      const picked = rs.filter((r) => selected.has(r.id)).length;
      const closing = rs.some((r) => r.badges.includes("closing") || r.badges.includes("missed"));
      if (rs.length === 1) {
        const r = rs[0];
        if (picked) Lf.circleMarker([lat, lng], { radius: 13, color: "#111827", weight: 3, fill: false, interactive: false }).addTo(g);
        Lf.circleMarker([lat, lng], { radius: 8, fillColor: colors.get(serviceKey(r)) ?? "#2563eb", fillOpacity: 0.95, color: closing ? "#dc2626" : "#ffffff", weight: closing ? 4 : 2 })
          .bindTooltip(`${r.property.street} · ${r.service.name}${r.dueBy ? ` · due ${shortDay(r.dueBy)}` : ""}${r.estMinutes ? ` · ${hoursText(r.estMinutes)} h` : ""}`)
          .on("click", () => onToggle([r.id]))
          .addTo(g);
        continue;
      }
      const sameSpot = rs.every((r) => r.property.lat === rs[0].property.lat && r.property.lng === rs[0].property.lng);
      const size = rs.length < 10 ? 30 : rs.length < 100 ? 36 : 42;
      const icon = Lf.divIcon({
        className: "", iconSize: [size, size],
        html: `<div class="wl-cluster${picked ? " picked" : ""}${closing ? " closing" : ""}" style="width:${size}px;height:${size}px">${rs.length}${picked ? `<small>${picked}✓</small>` : ""}</div>`,
      });
      Lf.marker([lat, lng], { icon, keyboard: true, title: `${rs.length} services${picked ? `, ${picked} selected` : ""}` })
        .on("click", () => {
          if (sameSpot || z >= 17) onToggle(rs.map((r) => r.id));
          else m.fitBounds(Lf.latLngBounds(rs.map((r) => [r.property.lat!, r.property.lng!] as [number, number])), { padding: [40, 40], maxZoom: 18 });
        })
        .addTo(g);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rows, selected, zoom, colors]);

  // Draw a box: drag on the map to select every pin inside.
  useEffect(() => {
    const m = map.current, Lf = L.current, box = el.current;
    if (!ready || !m || !Lf || !box || !boxMode) return;
    m.dragging.disable();
    box.style.cursor = "crosshair";
    let start: import("leaflet").LatLng | null = null;
    let rect: import("leaflet").Rectangle | null = null;
    const at = (e: PointerEvent) => m.mouseEventToLatLng(e as unknown as MouseEvent);
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".leaflet-control")) return;
      start = at(e); box.setPointerCapture(e.pointerId);
      rect = Lf.rectangle(Lf.latLngBounds(start, start), { color: "#111827", weight: 1, dashArray: "4 4", fillOpacity: 0.08 }).addTo(m);
    };
    const move = (e: PointerEvent) => { if (start && rect) rect.setBounds(Lf.latLngBounds(start, at(e))); };
    const up = (e: PointerEvent) => {
      if (!start || !rect) return;
      const b = Lf.latLngBounds(start, at(e));
      rect.remove(); rect = null; start = null;
      onSelect(mapped.filter((r) => b.contains([r.property.lat!, r.property.lng!])).map((r) => r.id));
      setBoxMode(false);
    };
    box.addEventListener("pointerdown", down);
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    return () => {
      box.removeEventListener("pointerdown", down); box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up);
      rect?.remove(); m.dragging.enable(); box.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, boxMode, rows]);

  // Full screen: Esc leaves; the map re-measures after any size change.
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [full]);
  useEffect(() => { const t = setTimeout(() => map.current?.invalidateSize(), 60); return () => clearTimeout(t); }, [full, height]);

  // Drag the bottom edge to resize.
  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = height;
    const mv = (ev: PointerEvent) => setPrefs((p) => ({ ...p, height: Math.max(200, Math.min(window.innerHeight - 120, h0 + ev.clientY - y0)) }));
    const done = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", done); setPrefs((p) => { writeLocal("wl-map", p); return p; }); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", done);
  };

  const legend = [...colors.entries()].filter(([k]) => rows.some((r) => serviceKey(r) === k));
  return (
    <div className={`card wl-map-card${full ? " wl-map-full" : ""}`} ref={wrap}>
      <div className="wl-map-bar">
        <strong>Map</strong>
        <span className="muted">{mapped.length} on the map{unmapped ? ` · ${unmapped} without a map location` : ""}</span>
        <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
          {!prefs.collapsed && <button type="button" className={`btn sm${boxMode ? " primary" : ""}`} aria-pressed={boxMode} onClick={() => setBoxMode(!boxMode)} title="Drag a box on the map to select every pin inside">{boxMode ? "Drag on the map…" : "Draw a box"}</button>}
          {!prefs.collapsed && <button type="button" className="btn sm" onClick={() => setFull(!full)} aria-pressed={full}>{full ? "Exit full screen" : "Full screen"}</button>}
          {!full && <button type="button" className="btn sm" onClick={() => save({ ...prefs, collapsed: !prefs.collapsed })} aria-expanded={!prefs.collapsed}>{prefs.collapsed ? "Show map" : "Hide map"}</button>}
        </span>
      </div>
      {!prefs.collapsed && (
        <>
          <div ref={el} className="wl-map" style={{ height: full ? undefined : height }} />
          {!full && <div className="wl-resize" role="separator" aria-label="Drag to resize the map" onPointerDown={startResize} />}
          <div className="wl-legend muted">
            {legend.map(([k, c]) => <span key={k}><span className="wl-dot" style={{ background: c }} />{rows.find((r) => serviceKey(r) === k)?.service.name}</span>)}
            <span><span className="wl-dot wl-dot-closing" />Red ring: closing or missed</span>
            <span><span className="wl-dot wl-dot-picked" />Selected</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────── Workload strip ───────────── */

/** Hours booked per crew each day of the week against their day; click a day to schedule the selection into it. */
export function WorkloadStrip({ today, selectedMinutes, onPick, reloadKey }: { today: string; selectedMinutes: number; onPick: (date: string, crewId: string | null) => void; reloadKey: number }) {
  const [from, setFrom] = useState(today);
  const w = useApi<Workload>(`/waitlist/workload?from=${from}&days=7&k=${reloadKey}`);
  const d = w.data;
  return (
    <div className="card wl-work">
      <div className="wl-map-bar">
        <strong>Workload</strong>
        <span className="muted">Hours booked against each crew&apos;s day{selectedMinutes ? ` · click a day to schedule the selected (${hoursText(selectedMinutes)} h)` : ""}</span>
        <span className="row" style={{ gap: 4, marginLeft: "auto" }}>
          <button type="button" className="btn sm" aria-label="Previous week" disabled={from <= today} onClick={() => setFrom(plusDays(from, -7) < today ? today : plusDays(from, -7))}>‹</button>
          <button type="button" className="btn sm" onClick={() => setFrom(today)} disabled={from === today}>This week</button>
          <button type="button" className="btn sm" aria-label="Next week" onClick={() => setFrom(plusDays(from, 7))}>›</button>
        </span>
      </div>
      <ErrorBox error={w.error} />
      {d && (
        <div className="wl-work-scroll">
          <table className="wl-work-grid">
            <thead>
              <tr>
                <th />
                {d.dates.map((x) => (
                  <th key={x} className={d.holidays[x] ? "holiday" : undefined}>
                    <button type="button" className="cl-sort" onClick={() => onPick(x, null)} title={selectedMinutes ? "Schedule the selected on this day" : "Pick this day"}>{dayLabel(x)}</button>
                    {d.holidays[x] && <div className="wl-hol">{d.holidays[x]}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.crews.filter((c) => c.id || c.days.some((x) => x.count)).map((c) => (
                <tr key={c.id ?? "none"}>
                  <th scope="row"><span className="wl-dot" style={{ background: c.color }} />{c.name}{c.dailyHours ? <span className="muted"> · {c.dailyHours} h</span> : null}</th>
                  {c.days.map((x, i) => {
                    const pct = c.dailyHours ? Math.min(100, (x.hours / c.dailyHours) * 100) : 0;
                    const over = !!c.dailyHours && x.hours > c.dailyHours;
                    return (
                      <td key={i} className={d.holidays[d.dates[i]] ? "holiday" : undefined}>
                        <button type="button" className="wl-day" onClick={() => onPick(d.dates[i], c.id)} title={`${x.count} work order${x.count === 1 ? "" : "s"}, ${x.hours} h${c.dailyHours ? ` of ${c.dailyHours} h` : ""}`}>
                          <span className={over ? "bad-text" : undefined}>{x.hours}{c.dailyHours ? ` / ${c.dailyHours}` : ""} h</span>
                          {c.dailyHours ? <span className="wl-bar"><span style={{ width: `${pct}%`, background: over ? "var(--bad)" : c.color }} /></span> : <span className="muted wl-count">{x.count} booked</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {d.crews.length === 1 && <p className="muted" style={{ margin: "6px 0 0" }}>No crews yet. <Link href="/crews">Add crews</Link> (with their hours per day) to see each one&apos;s day here.</p>}
        </div>
      )}
    </div>
  );
}

/* ───────────── Edit work orders ───────────── */

/**
 * Schedules the selected work orders in one step: the date, crew and appointment window, and
 * optionally the crew as each property's preferred crew and a heads-up by each customer's preference.
 */
export function EditWorkOrders({ rows, crews, today, initial, onClose, onDone }: {
  rows: WaitRow[]; crews: Crew[]; today: string; initial?: { date?: string; crewId?: string | null };
  onClose: () => void; onDone: (message: string) => void;
}) {
  const common = rows.every((r) => r.preferredCrewId && r.preferredCrewId === rows[0].preferredCrewId) ? rows[0].preferredCrewId : null;
  const [date, setDate] = useState(initial?.date ?? today);
  const [crewId, setCrewId] = useState<string>(initial?.crewId ?? common ?? "");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [makePreferred, setMakePreferred] = useState(false);
  const [notify, setNotify] = useState(rows.some((r) => r.badges.includes("text_ahead") || r.badges.includes("call_ahead")));
  const [earlyReason, setEarlyReason] = useState("");
  const act = useAction();
  const w = useApi<Workload>(date ? `/waitlist/workload?from=${date}&days=1` : null);
  const t = totalsOf(rows);
  const needCard = rows.filter((r) => r.needsCard);
  const early = rows.filter((r) => r.eligible && date < r.eligible);
  const missed = rows.filter((r) => r.dueBy && date > r.dueBy);
  const lane = w.data?.crews.find((c) => (c.id ?? "") === crewId);
  const booked = lane?.days[0]?.hours ?? 0;
  const after = Math.round((booked + t.minutes / 60) * 10) / 10;
  const holiday = w.data?.holidays[date];
  const toText = rows.filter((r) => r.badges.includes("text_ahead")).length;
  const toCall = rows.filter((r) => r.badges.includes("call_ahead")).length;
  const windows = rows.filter((r) => r.windowStart && windowStart && windowStart < r.windowStart);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    act.run(async () => {
      const r = await api<{ scheduled: number; early: number; texted: number; notTexted: number; toCall: string[] }>("/waitlist/schedule", {
        method: "POST", body: { visitIds: rows.map((x) => x.id), date, crewId: crewId || null, windowStart: windowStart || null, windowEnd: windowStart ? windowEnd || null : null, makePreferred, notify, earlyReason: early.length ? earlyReason : null },
      });
      const parts = [`Scheduled ${r.scheduled} for ${dayLabel(date, { weekday: "long", month: "short", day: "numeric" })}${crewId ? ` (${crewName(crewId, crews)})` : ""}.`];
      if (r.texted) parts.push(`Texted ${r.texted}.`);
      if (r.notTexted) parts.push(`${r.notTexted} want a text but it wasn't sent (texting isn't connected or they have no mobile number).`);
      if (r.toCall.length) parts.push(`Call ahead: ${r.toCall.join(", ")}.`);
      onDone(parts.join(" "));
    });
  };

  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="cal-modal card stack wl-edit" role="dialog" aria-label="Edit work orders" onSubmit={submit}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Edit work orders</h2>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        <p className="muted" style={{ margin: 0 }}>{totalsText(t)}</p>
        {needCard.length > 0 && (
          <div className="alert bad">
            <strong>Needs a card on file:</strong> {[...new Set(needCard.map((r) => r.customer.name))].join(", ")}. Add a card on their customer page, or turn the requirement off for them there, then schedule. Or unselect them.
          </div>
        )}
        <div className="formgrid">
          <label>Date *<input type="date" required min={today} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Crew
            <select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">No crew yet</option>
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === common ? " (preferred)" : ""}</option>)}
            </select>
          </label>
          <label>Appointment window from<input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} /></label>
          {windowStart && <label>Until (optional)<input type="time" min={windowStart} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} /></label>}
        </div>
        {w.data && (
          <p className={`muted wl-adds${lane?.dailyHours && after > lane.dailyHours ? " bad-text" : ""}`} style={{ margin: 0 }}>
            {crewId
              ? <>Adds {hoursText(t.minutes)} h on site: {crewName(crewId, crews)} goes from {booked} to {after} h{lane?.dailyHours ? ` of ${lane.dailyHours} h` : ""} on {dayLabel(date)}.{lane?.dailyHours && after > lane.dailyHours ? " That's over their day." : ""}</>
              : <>Adds {hoursText(t.minutes)} h on site. Pick a crew to see how it fits their day.</>}
          </p>
        )}
        {holiday && <div className="alert warn">{dayLabel(date)} is a holiday ({holiday}).</div>}
        {missed.length > 0 && <div className="alert warn">{missed.length} will be after {missed.length === 1 ? "its" : "their"} due-by date.</div>}
        {windows.length > 0 && <div className="alert warn">{windows.length} already {windows.length === 1 ? "has" : "have"} a later appointment window; this replaces it.</div>}
        {early.length > 0 && (
          <div className="alert warn stack" style={{ gap: 6 }}>
            <span>{early.length === 1 ? "This isn't" : `${early.length} aren't`} eligible until later (minimum days since the last service): {early.slice(0, 5).map((r) => `${r.property.street} (${shortDay(r.eligible)})`).join(", ")}{early.length > 5 ? "…" : ""}.</span>
            <label>Why it&apos;s OK to do {early.length === 1 ? "it" : "them"} sooner *<input required value={earlyReason} maxLength={300} onChange={(e) => setEarlyReason(e.target.value)} placeholder="Customer asked; label allows 14 days…" /></label>
          </div>
        )}
        <div className="stack" style={{ gap: 4 }}>
          {crewId && <label className="check"><input type="checkbox" checked={makePreferred} onChange={(e) => setMakePreferred(e.target.checked)} /> Make {crewName(crewId, crews)} the preferred crew for {rows.length === 1 ? "this property" : "these properties"}</label>}
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={!toText && !toCall} /> Notify customers by their preference{toText || toCall ? ` (${[toText && `${toText} by text`, toCall && `${toCall} to call`].filter(Boolean).join(", ")})` : " (none asked for notice)"}</label>
        </div>
        <ErrorBox error={act.error} />
        <div className="row">
          <button className="btn primary" disabled={act.busy || needCard.length > 0 || !rows.length}>Schedule {rows.length}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** Puts a scheduled work order back on the waiting list, with the reason (rain, no access…). */
export function BackToWaitlist({ visitId, onDone }: { visitId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof BACK_REASONS)[number]>("rain");
  const [note, setNote] = useState("");
  const act = useAction();
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Back to waiting list</button>;
  return (
    <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api("/waitlist/back", { method: "POST", body: { visitIds: [visitId], reason, note } }); setOpen(false); onDone(); }); }}>
      <div className="formgrid">
        <label>Why<select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>{BACK_REASONS.map((r) => <option key={r} value={r}>{BACK_REASON_LABELS[r]}</option>)}</select></label>
        <label>Note (optional)<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Storms all afternoon" /></label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={act.busy}>Move it back</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorBox error={act.error} />
    </form>
  );
}

/* ───────────── Preferences (customer and property pages) ───────────── */

/** How the customer wants to hear before a visit, and the card-on-file exemption. */
export function CustomerSchedulingPrefs({ customer, onSaved }: { customer: { id: string; notifyBefore?: NotifyBefore | null; cardExemptReason?: string | null; cardExemptAt?: string | null }; onSaved: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState("");
  const [exempting, setExempting] = useState(false);
  const notify = (v: NotifyBefore) => act.run(async () => { await api(`/waitlist/customer/${customer.id}`, { method: "PUT", body: { notifyBefore: v } }); onSaved(); });
  const exempt = (on: boolean) => act.run(async () => { await api("/waitlist/card-exempt", { method: "PUT", body: { customerId: customer.id, exempt: on, reason: on ? reason : undefined } }); setExempting(false); setReason(""); onSaved(); });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label>Before a visit
        <select value={customer.notifyBefore ?? "none"} disabled={act.busy} onChange={(e) => notify(e.target.value as NotifyBefore)}>
          {NOTIFY_BEFORE.map((n) => <option key={n} value={n}>{NOTIFY_BEFORE_LABELS[n]}</option>)}
        </select>
      </label>
      {customer.cardExemptAt ? (
        <p style={{ margin: 0 }}>Card on file not required: {customer.cardExemptReason} <button type="button" className="linkbtn" disabled={act.busy} onClick={() => exempt(false)}>Require it again</button></p>
      ) : exempting ? (
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) exempt(true); }}>
          <input aria-label="Why" required autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. net 30, pays by check)" style={{ flex: 1, minWidth: 160 }} />
          <button className="btn sm primary" disabled={act.busy}>Save</button><button type="button" className="btn sm" onClick={() => setExempting(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="linkbtn" style={{ justifySelf: "start" }} onClick={() => setExempting(true)}>Don&apos;t require a card on file for this customer</button>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** A property's preferred crew and notice (overrides the customer's), and its card exemption. */
export function PropertySchedulingPrefs({ property, onSaved }: { property: { id: string; notifyBefore?: NotifyBefore | null; preferredCrewId?: string | null; cardExemptReason?: string | null; cardExemptAt?: string | null }; onSaved: () => void }) {
  const crews = useApi<{ id: string; name: string; active: boolean }[]>("/crews");
  const act = useAction();
  const [reason, setReason] = useState("");
  const [exempting, setExempting] = useState(false);
  const put = (patch: { notifyBefore?: NotifyBefore | null; preferredCrewId?: string | null }) => act.run(async () => {
    await api(`/waitlist/property/${property.id}`, { method: "PUT", body: { notifyBefore: property.notifyBefore ?? null, preferredCrewId: property.preferredCrewId ?? null, ...patch } }); onSaved();
  });
  const exempt = (on: boolean) => act.run(async () => { await api("/waitlist/card-exempt", { method: "PUT", body: { propertyId: property.id, exempt: on, reason: on ? reason : undefined } }); setExempting(false); setReason(""); onSaved(); });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="formgrid">
        <label>Preferred crew
          <select value={property.preferredCrewId ?? ""} disabled={act.busy} onChange={(e) => put({ preferredCrewId: e.target.value || null })}>
            <option value="">None</option>
            {(crews.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Before a visit
          <select value={property.notifyBefore ?? ""} disabled={act.busy} onChange={(e) => put({ notifyBefore: (e.target.value || null) as NotifyBefore | null })}>
            <option value="">Same as the customer</option>
            {NOTIFY_BEFORE.map((n) => <option key={n} value={n}>{NOTIFY_BEFORE_LABELS[n]}</option>)}
          </select>
        </label>
      </div>
      {property.cardExemptAt ? (
        <p style={{ margin: 0 }}>Card on file not required here: {property.cardExemptReason} <button type="button" className="linkbtn" disabled={act.busy} onClick={() => exempt(false)}>Require it again</button></p>
      ) : exempting ? (
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) exempt(true); }}>
          <input aria-label="Why" required autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. commercial account, net 30)" style={{ flex: 1, minWidth: 160 }} />
          <button className="btn sm primary" disabled={act.busy}>Save</button><button type="button" className="btn sm" onClick={() => setExempting(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="linkbtn" style={{ justifySelf: "start" }} onClick={() => setExempting(true)}>Don&apos;t require a card on file for this property</button>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** Settings: a card (or bank account) on file before scheduling. */
export function CardOnFileCard({ value, onSaved }: { value: boolean; onSaved: (v: boolean) => void }) {
  const act = useAction();
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Card on file required</h2>
      <p className="muted" style={{ margin: 0 }}>Work orders for customers with no card or bank account on file show &quot;Needs card&quot; on the waiting list and can&apos;t be scheduled until one is added. You can turn it off for one customer or property (with why) on their page.</p>
      <label className="check"><input type="checkbox" checked={value} disabled={act.busy} onChange={(e) => act.run(async () => { await api("/waitlist/settings", { method: "PUT", body: { requireCardOnFile: e.target.checked } }); onSaved(e.target.checked); })} /> Require a card or bank account on file before scheduling</label>
      <ErrorBox error={act.error} />
    </div>
  );
}

/* ───────────── The list ───────────── */

export function WaitTable({ rows, crews, columns, sort, onSort, selected, setSelected, limit, onMore }: {
  rows: WaitRow[]; crews: Crew[]; columns: string[]; sort: WaitView["sort"]; onSort: (key: string) => void;
  selected: Set<string>; setSelected: (s: Set<string>) => void; limit: number; onMore: () => void;
}) {
  const cols = columns.map((k) => colByKey.get(k)).filter((c): c is WCol => !!c);
  const t = totalsOf(rows);
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  const total = (k: string) => (k === "est" ? `${hoursText(t.minutes)}` : k === "sqft" ? Math.round(t.sqFt).toLocaleString() : k === "price" ? formatMoney(t.cents) : "");
  return (
    <div className="table-wrap wl-table-wrap">
      <table className="cl-table wl-table">
        <thead>
          <tr>
            <th className="cl-check"><input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={() => setSelected(allOn ? new Set([...selected].filter((id) => !rows.some((r) => r.id === id))) : new Set([...selected, ...rows.map((r) => r.id)]))} /></th>
            {cols.map((c) => (
              <th key={c.key} className={c.num ? "num" : undefined} aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                {c.sort ? <button type="button" className="cl-sort" onClick={() => onSort(c.key)}>{c.label}{sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</button> : c.label}
              </th>
            ))}
          </tr>
          <tr className="wl-totals">
            <td />
            {cols.map((c, i) => <td key={c.key} className={c.num ? "num" : undefined}>{i === 0 ? <strong>{rows.length} shown</strong> : <strong>{total(c.key)}</strong>}</td>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => (
            <tr key={r.id} className={selected.has(r.id) ? "picked" : undefined}>
              <td className="cl-check"><input type="checkbox" aria-label={`Select ${r.property.street}, ${r.service.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
              {cols.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.cell ? c.cell(r, crews) : c.text(r, crews) || <span className="muted">—</span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <div className="cl-pager"><span className="muted">Showing {limit} of {rows.length}</span><button type="button" className="btn" onClick={onMore}>Show more</button></div>}
    </div>
  );
}

/** Hours, count and dollars of the selection, by crew and by service. */
export function SelectionBreakdown({ rows, crews }: { rows: WaitRow[]; crews: Crew[] }) {
  const [open, setOpen] = useState(false);
  const by = (k: (r: WaitRow) => string) => {
    const m = new Map<string, WaitRow[]>();
    for (const r of rows) m.set(k(r), [...(m.get(k(r)) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const table = (title: string, groups: [string, WaitRow[]][]) => (
    <div>
      <div className="todo-label">{title}</div>
      <table className="wl-break">
        <tbody>{groups.map(([name, rs]) => { const t = totalsOf(rs); return <tr key={name}><td>{name}</td><td className="num">{t.count}</td><td className="num">{hoursText(t.minutes)} h</td><td className="num">{formatMoney(t.cents)}</td></tr>; })}</tbody>
      </table>
    </div>
  );
  return (
    <Popover open={open} setOpen={setOpen} buttonClass="linkbtn" label="By crew and service" className="cl-pop-wide">
      <div className="stack" style={{ gap: 10 }}>
        {table("By preferred crew", by((r) => crewName(r.preferredCrewId, crews) || "No preferred crew"))}
        {table("By service", by((r) => r.service.name))}
      </div>
    </Popover>
  );
}

/** The shown (or selected) rows as a spreadsheet. */
export function exportCsv(rows: WaitRow[], columns: string[], crews: Crew[]) {
  const cols = columns.map((k) => colByKey.get(k)).filter((c): c is WCol => !!c);
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [cols.map((c) => q(c.label)).join(","), ...rows.map((r) => cols.map((c) => q(c.text(r, crews))).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `waiting-list-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Ready-made views. */
export const BUILT_IN_WAIT_VIEWS: WaitView[] = [
  { name: "Waiting list", filters: [], columns: DEFAULT_WL_COLUMNS, sort: { key: "due", dir: "asc" } },
  { name: "Closing or missed", filters: [{ key: "badge", value: "closing" }, { key: "badge", value: "missed" }], columns: DEFAULT_WL_COLUMNS, sort: { key: "due", dir: "asc" } },
  { name: "High priority", filters: [{ key: "priority", value: "high" }], columns: DEFAULT_WL_COLUMNS, sort: { key: "due", dir: "asc" } },
  { name: "Needs a card", filters: [{ key: "badge", value: "needs_card" }], columns: [...DEFAULT_WL_COLUMNS.filter((k) => k !== "badges"), "customer", "badges"], sort: { key: "customer", dir: "asc" } },
  { name: "Back from the schedule", filters: [], columns: [...DEFAULT_WL_COLUMNS, "back"], sort: { key: "waited", dir: "desc" } },
  { name: "Coming up (not released yet)", filters: [{ key: "upcoming", value: "1" }], columns: [...DEFAULT_WL_COLUMNS.slice(0, 3), "released", ...DEFAULT_WL_COLUMNS.slice(3)], sort: { key: "eligible", dir: "asc" } },
];

export function badgeLegend() {
  return (Object.keys(BADGE_LABELS) as WaitBadge[]).map((b) => <span key={b}><span className={`wl-badge wl-b-${b}`}>{BADGE_LABELS[b]}</span> {BADGE_HINTS[b].replace(/^./, (c) => c.toLowerCase())}</span>);
}

/** Priority, skip (with why) and delete for the selection. */
export function BulkMenu({ busy, isAdmin, onPriority, onSkip, onDelete }: { busy: boolean; isAdmin: boolean; onPriority: (p: Priority) => void; onSkip: (reason: string) => void; onDelete: () => void }) {
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  if (skipping) {
    return (
      <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSkip(reason.trim()); }}>
        <label>Why are they skipped?<input autoFocus required value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Customer cancelled this round…" /></label>
        <div className="row"><button className="btn primary" disabled={busy}>Skip them</button><button type="button" className="btn" onClick={() => setSkipping(false)}>Back</button></div>
      </form>
    );
  }
  return (
    <div className="cl-menu">
      <div className="todo-label">Priority</div>
      {PRIORITIES.map((p) => <button key={p} type="button" disabled={busy} onClick={() => onPriority(p)}>{PRIORITY_LABELS[p]}</button>)}
      <hr />
      <button type="button" disabled={busy} onClick={() => setSkipping(true)}>Skip…</button>
      {isAdmin && <button type="button" className="bad-text" disabled={busy} onClick={onDelete}>Delete</button>}
    </div>
  );
}

/** Saves the filters, columns and sort as a view, for you or for everyone. */
export function SaveView({ open, setOpen, onSave, busy }: { open: boolean; setOpen: (o: boolean) => void; onSave: (name: string, shared: boolean) => void; busy: boolean }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  return (
    <Popover open={open} setOpen={setOpen} label="Save view">
      <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim(), shared); }}>
        <label>Name<input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Round 3, MC 4" /></label>
        <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone</label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Saves the filters, columns and sort.</p>
        <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </Popover>
  );
}
