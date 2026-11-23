"use client";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CUSTOMER_COLUMNS, CUSTOMER_FILTER_FIELDS, CUSTOMER_KIND_LABELS, DEFAULT_CUSTOMER_COLUMNS, DELIVERY_LABELS, FILTER_OPS,
  describeFilter, filterField, filterReady, formatCustomValue, formatMoney, formatPhone, paymentMethodLabel,
  type CustomFieldDef, type CustomerColumn, type CustomerFilter, type CustomerKind, type DeliveryMethod, type FilterField,
} from "@crewdesk/shared";
import { Badge } from "./ui";
import { TagChips, type Tag } from "./customers";
import { Icon } from "./icons";

/** A small drop-down panel under a button; closes on a click outside or Escape. */
export function Popover({ label, children, open, setOpen, align = "left", className = "", buttonClass = "btn", title }: {
  label: ReactNode; children: ReactNode; open: boolean; setOpen: (o: boolean) => void; align?: "left" | "right"; className?: string; buttonClass?: string; title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // Flip to the other side when the panel would run off the screen (the toolbar wraps on narrow screens).
  const [side, setSide] = useState(align);
  useLayoutEffect(() => {
    if (!open) { setSide(align); return; }
    const r = pop.current?.getBoundingClientRect();
    if (!r) return;
    // Checked once per opening, against the default side, so it can't flip back and forth.
    if (align === "left" && r.right > window.innerWidth - 8) setSide("right");
    else if (align === "right" && r.left < 8) setSide("left");
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, setOpen]);
  return (
    <div className="cl-pop-wrap" ref={ref}>
      <button type="button" className={buttonClass} aria-expanded={open} title={title} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div ref={pop} className={`cl-pop ${side === "right" ? "align-right" : ""} ${className}`} role="dialog">{children}</div>}
    </div>
  );
}

type Opt = { id: string; name: string };
/** Ticks for picking several values (statuses, tags, services…). */
function Checks({ options, value, onChange, empty }: { options: Opt[]; value: string[]; onChange: (v: string[]) => void; empty?: string }) {
  if (!options.length) return <p className="muted" style={{ margin: 0 }}>{empty ?? "Nothing to pick."}</p>;
  return (
    <div className="cl-checks">
      {options.map((o) => (
        <label key={o.id} className="check"><input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> {o.name}</label>
      ))}
    </div>
  );
}

const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);

/**
 * One filter rule, like Homeworks': the field, the comparison, then the value(s) the field needs
 * (text, a choice, an amount, dates, tags, or a service with optional dates).
 */
export function FilterEditor({ initial, custom, tags, services, onApply, onCancel, onRemove }: {
  initial?: CustomerFilter; custom: CustomFieldDef[]; tags: Tag[]; services: Opt[];
  onApply: (r: CustomerFilter) => void; onCancel: () => void; onRemove?: () => void;
}) {
  const [r, setR] = useState<CustomerFilter>(initial ?? { f: "", op: "" });
  const field = r.f ? filterField(r.f, custom) : undefined;
  const ops = field ? (FILTER_OPS[field.kind] as readonly (readonly [string, string])[]) : [];
  const pick = (f: string) => {
    const fd = filterField(f, custom);
    setR({ f, op: fd ? (FILTER_OPS[fd.kind] as readonly (readonly [string, string])[])[0][0] : "" });
  };
  const groups = useMemo(() => {
    const all: FilterField[] = [...CUSTOMER_FILTER_FIELDS, ...custom.map((c) => filterField(`cf:${c.id}`, custom)!).filter(Boolean)];
    const g = new Map<string, FilterField[]>();
    for (const f of all) g.set(f.group, [...(g.get(f.group) ?? []), f]);
    return [...g.entries()];
  }, [custom]);
  const ready = filterReady(r, field);
  const input = (k: "v" | "v2", type: string, placeholder?: string) => (
    <input aria-label={k === "v" ? "Value" : "Second value"} type={type} inputMode={field?.kind === "money" || field?.kind === "number" ? "decimal" : undefined}
      value={r[k] == null ? "" : String(r[k])} placeholder={placeholder} onChange={(e) => setR({ ...r, [k]: e.target.value })} />
  );
  let value: ReactNode = null;
  if (field) {
    switch (field.kind) {
      case "text": value = r.op === "blank" || r.op === "notblank" ? null : input("v", "text", field.key === "phone" ? "Digits, e.g. 0101" : "Type here"); break;
      case "enum": value = <Checks options={(field.options ?? []).map(([id, name]) => ({ id, name }))} value={asList(r.v)} onChange={(v) => setR({ ...r, v })} />; break;
      case "tags": value = <Checks options={tags.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name }))} value={asList(r.v)} onChange={(v) => setR({ ...r, v })} empty="No tags yet." />; break;
      case "number":
      case "money": {
        const prefix = field.kind === "money" ? "$" : "";
        value = r.op === "between"
          ? <div className="row cl-between">{prefix}{input("v", "text", "From")} and {prefix}{input("v2", "text", "To")}</div>
          : <div className="row cl-between">{prefix}{input("v", "text", field.kind === "money" ? "0.00" : "0")}</div>;
        break;
      }
      case "date": value = r.op === "never" ? null : r.op === "between" ? <div className="row cl-between">{input("v", "date")} to {input("v2", "date")}</div> : input("v", "date"); break;
      case "service":
        value = (
          <div className="stack" style={{ gap: 6 }}>
            <span className="todo-label">Which services (none ticked: any)</span>
            <Checks options={services} value={asList(r.v)} onChange={(v) => setR({ ...r, v })} empty="No services on the price list yet." />
            {r.op !== "never" && (
              <div className="row cl-between">
                <label>From<input type="date" value={r.from ?? ""} onChange={(e) => setR({ ...r, from: e.target.value || null })} /></label>
                <label>To<input type="date" value={r.to ?? ""} onChange={(e) => setR({ ...r, to: e.target.value || null })} /></label>
              </div>
            )}
          </div>
        );
        break;
      default: value = null;
    }
  }
  return (
    <form className="stack cl-editor" onSubmit={(e) => { e.preventDefault(); if (ready) onApply(r); }}>
      <div className="cl-editor-row">
        <select aria-label="Filter by" value={r.f} onChange={(e) => pick(e.target.value)} autoFocus={!initial}>
          <option value="">Filter by…</option>
          {groups.map(([g, fs]) => <optgroup key={g} label={g}>{fs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}
        </select>
        {field && (
          <select aria-label="Comparison" value={r.op} onChange={(e) => setR({ ...r, op: e.target.value })}>
            {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        )}
      </div>
      {value}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <button className="btn primary" disabled={!ready}>{initial ? "Update" : "Apply filter"}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
        {onRemove && <button type="button" className="linkbtn" onClick={onRemove}>Remove</button>}
      </div>
    </form>
  );
}

/** The filters in use, as chips (click to change, ✕ to remove), plus Clear all. */
export function FilterChips({ filters, custom, tags, services, onEdit, onRemove, onClear }: {
  filters: CustomerFilter[]; custom: CustomFieldDef[]; tags: Tag[]; services: Opt[];
  onEdit: (i: number) => void; onRemove: (i: number) => void; onClear: () => void;
}) {
  if (!filters.length) return null;
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name ?? "a removed tag";
  const serviceName = (id: string) => services.find((s) => s.id === id)?.name ?? "a removed service";
  return (
    <div className="cl-chips" aria-label="Filters in use">
      {filters.map((r, i) => (
        <span key={i} className="cl-chip">
          <button type="button" className="cl-chip-text" onClick={() => onEdit(i)} title="Change this filter">{describeFilter(r, { field: filterField(r.f, custom), tagName, serviceName })}</button>
          <button type="button" className="cl-chip-x" aria-label="Remove this filter" onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
      {filters.length > 1 && <button type="button" className="linkbtn" onClick={onClear}>Clear all</button>}
    </div>
  );
}

/* ───────────── Columns ───────────── */

export type Col = CustomerColumn & { custom?: CustomFieldDef };
/** Every column, the company's customer custom fields included. */
export function allColumns(custom: CustomFieldDef[]): Col[] {
  return [...CUSTOMER_COLUMNS, ...custom.map((c) => ({ key: `cf:${c.id}`, label: c.name, group: "Custom fields", custom: c, align: c.type === "integer" || c.type === "decimal" ? "right" as const : undefined }))];
}
const shortDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "");
const contactPerson = (c: any) => (c.kind !== "residential" ? [c.firstName, c.lastName].filter(Boolean).join(" ") : "");
const billing = (c: any) => [c.billingStreet, [c.billingCity, c.billingState].filter(Boolean).join(", "), c.billingZip].filter(Boolean).join(" ");
const money = (c: number | null | undefined) => (c ? formatMoney(c) : "");

/** A cell as plain text (the spreadsheet export). */
export function cellText(col: Col, c: any, tags: Tag[]): string {
  if (col.custom) return formatCustomValue(col.custom, c.custom?.[col.custom.id]);
  switch (col.key) {
    case "number": return String(c.number ?? "");
    case "name": return c.name;
    case "type": return CUSTOMER_KIND_LABELS[c.kind as CustomerKind] ?? c.kind;
    case "status": return c.status;
    case "contact": return contactPerson(c);
    case "tags": return tags.filter((t) => c.tagIds?.includes(t.id)).map((t) => t.name).join("; ");
    case "source": return c.source ?? "";
    case "since": return shortDate(c.createdAt);
    case "phone": return c.phone ? formatPhone(c.phone) : "";
    case "altPhone": return c.altPhone ? formatPhone(c.altPhone) : "";
    case "email": return c.email ?? "";
    case "delivery": return (c.delivery ?? []).map((d: string) => DELIVERY_LABELS[d as DeliveryMethod] ?? d).join(", ");
    case "address": return c.address ?? "";
    case "city": return c.city ?? c.billingCity ?? "";
    case "zip": return c.zip ?? c.billingZip ?? "";
    case "billing": return billing(c);
    case "properties": return String(c.propertyCount ?? 0);
    case "balance": return money(c.balanceCents);
    case "overdue": return money(c.overdueCents);
    case "credit": return money(c.creditCents);
    case "prepaid": return money(c.prepaidCents);
    case "revenue": return money(c.revenueCents);
    case "taxExempt": return c.taxExempt ? "Yes" : "";
    case "autopay": return c.autopay ? "On" : "";
    case "onFile": {
      if (!c.onFile) return "";
      const [type, brand, bankName, accountType, last4] = String(c.onFile).split("|");
      return paymentMethodLabel({ type, brand: brand || null, bankName: bankName || null, accountType: accountType || null, last4: last4 || null });
    }
    case "emailOptOut": return c.emailOptOutAt ? `Since ${new Date(c.emailOptOutAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "";
    case "po": return c.poRequired ? "Yes" : "";
    case "lastService": return shortDate(c.lastService);
    case "nextService": return shortDate(c.nextService);
    case "notes": return c.notes ?? "";
    default: return "";
  }
}

/** A cell in the table. */
export function Cell({ col, c, tags }: { col: Col; c: any; tags: Tag[] }) {
  switch (col.key) {
    case "name":
      return (
        <>
          <Link href={`/customers/${c.id}`}><strong>{c.name}</strong></Link>
          {c.sample && <span className="muted"> · sample</span>}
        </>
      );
    case "status": return <Badge value={c.status} />;
    case "tags": return <TagChips ids={c.tagIds} tags={tags} />;
    case "email": return c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null;
    case "phone": return c.phone ? <a href={`tel:${c.phone}`}>{formatPhone(c.phone)}</a> : null;
    case "balance": return c.balanceCents ? <span className={c.overdueCents ? "bad-text" : undefined}>{formatMoney(c.balanceCents)}</span> : <span className="muted">—</span>;
    case "overdue": return c.overdueCents ? <span className="bad-text">{formatMoney(c.overdueCents)}</span> : <span className="muted">—</span>;
    case "notes": return <span className="cl-notes" title={c.notes ?? ""}>{c.notes}</span>;
    default: {
      const t = cellText(col, c, tags);
      return t ? <>{t}</> : <span className="muted">—</span>;
    }
  }
}

/**
 * Pick and order the columns (Homeworks' "9/9 Columns", with more to choose from): the shown ones
 * in order (↑ ↓ to move, ✕ to hide), then every other column by group, with a search.
 */
export function ColumnPicker({ cols, shown, onChange }: { cols: Col[]; shown: string[]; onChange: (keys: string[]) => void }) {
  const [q, setQ] = useState("");
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const hidden = cols.filter((c) => !shown.includes(c.key) && (!q.trim() || `${c.label} ${c.group}`.toLowerCase().includes(q.trim().toLowerCase())));
  const groups = [...new Set(hidden.map((c) => c.group))];
  const move = (i: number, d: -1 | 1) => { const n = [...shown]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  return (
    <div className="stack cl-columns">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Shown, in order</strong>
        <button type="button" className="linkbtn" onClick={() => onChange(DEFAULT_CUSTOMER_COLUMNS)}>Reset</button>
      </div>
      <ol className="cl-shown">
        {shown.filter((k) => byKey.has(k)).map((k, i, arr) => (
          <li key={k}>
            <span>{byKey.get(k)!.label}<span className="muted"> · {byKey.get(k)!.group}</span></span>
            <span className="row" style={{ gap: 2 }}>
              <button type="button" className="btn" aria-label={`Move ${byKey.get(k)!.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn" aria-label={`Move ${byKey.get(k)!.label} down`} disabled={i === arr.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn" aria-label={`Hide ${byKey.get(k)!.label}`} disabled={k === "name"} onClick={() => onChange(shown.filter((x) => x !== k))}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <input type="search" placeholder="Find a column to add" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a column" />
      <div className="cl-addcols">
        {groups.map((g) => (
          <div key={g}>
            <div className="todo-label">{g}</div>
            {hidden.filter((c) => c.group === g).map((c) => (
              <button key={c.key} type="button" className="cl-addcol" onClick={() => onChange([...shown, c.key])}><Icon name="plus" size={12} /> {c.label}</button>
            ))}
          </div>
        ))}
        {!groups.length && <p className="muted" style={{ margin: 0 }}>{q ? "No columns match." : "Every column is shown."}</p>}
      </div>
    </div>
  );
}

/* ───────────── Views ───────────── */

export interface ListView { name: string; status: string; q: string; filters: CustomerFilter[]; sort: string; dir: "asc" | "desc"; columns?: string[] }
const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
const lastYearEnd = () => `${new Date().getFullYear() - 1}-12-31`;
/** Ready-made views for everyday questions. */
export const BUILT_IN_VIEWS = (): ListView[] => [
  { name: "Owes money", status: "all", q: "", filters: [{ f: "balance", op: "gt", v: "0" }], sort: "balance", dir: "desc" },
  { name: "Overdue", status: "all", q: "", filters: [{ f: "overdue", op: "yes" }], sort: "overdue", dir: "desc" },
  { name: "Nothing scheduled", status: "active", q: "", filters: [{ f: "nextService", op: "no" }], sort: "lastService", dir: "asc" },
  { name: "Not serviced this year", status: "active", q: "", filters: [{ f: "lastService", op: "before", v: lastYearEnd() }], sort: "lastService", dir: "asc" },
  { name: "Never serviced", status: "active", q: "", filters: [{ f: "lastService", op: "never" }], sort: "since", dir: "desc" },
  { name: "New this month", status: "all", q: "", filters: [{ f: "since", op: "after", v: firstOfMonth() }], sort: "since", dir: "desc" },
  { name: "Unused credit or prepaid", status: "all", q: "", filters: [{ f: "credit", op: "gt", v: "0" }], sort: "credit", dir: "desc" },
];

export function readLocal<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: kept until the tab closes */ }
}

/** Customers and Properties (the tabs above both lists). */
export function CrmTabs({ at }: { at: "customers" | "properties" | "messages" }) {
  const tab = (k: typeof at, href: string, label: string) => <Link href={href} aria-current={at === k ? "page" : undefined} className={at === k ? "on" : ""}>{label}</Link>;
  return (
    <nav className="cal-seg crm-tabs" aria-label="Customers, properties or messages">
      {tab("customers", "/customers", "Customers")}
      {tab("properties", "/properties", "Properties")}
      {tab("messages", "/customers/messages", "Messages")}
    </nav>
  );
}

