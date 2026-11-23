"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CUSTOMER_KIND_LABELS, CUSTOMER_KINDS, DELIVERY_LABELS, DELIVERY_METHODS, LEAD_SOURCES, TAG_COLORS, formatPhoneTyping, lawnTotal,
  type CustomerContactInput, type CustomValues,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { CustomFieldInputs } from "./custom-fields";

export interface Tag { id: string; name: string; color: string; description?: string | null; archived: boolean; customers?: number; properties?: number }

/** The company's customer and property tags. */
export function useTags() {
  const { data, reload } = useApi<Tag[]>("/crm/tags");
  return { tags: data ?? [], reload };
}

export function TagChip({ tag, children }: { tag: Pick<Tag, "name" | "color">; children?: ReactNode }) {
  return <span className={`tag tag-${tag.color}`}>{tag.name}{children}</span>;
}

/** The tags on a record, in the company's tag order. */
export function TagChips({ ids, tags }: { ids: string[] | null | undefined; tags: Tag[] }) {
  const list = tags.filter((t) => ids?.includes(t.id));
  if (!list.length) return null;
  return <span className="tag-list">{list.map((t) => <TagChip key={t.id} tag={t} />)}</span>;
}

/** Click tags to put them on or take them off (archived tags only show if already on). */
export function TagPicker({ value, onChange, tags, label = "Tags" }: { value: string[]; onChange: (ids: string[]) => void; tags: Tag[]; label?: string }) {
  const shown = tags.filter((t) => !t.archived || value.includes(t.id));
  return (
    <fieldset className="tag-picker">
      <legend>{label}</legend>
      {shown.length ? shown.map((t) => {
        const on = value.includes(t.id);
        return (
          <button key={t.id} type="button" aria-pressed={on} className={`tag tag-${t.color} tag-toggle ${on ? "on" : ""}`}
            onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}>
            {on ? "✓ " : ""}{t.name}
          </button>
        );
      }) : <span className="muted">No tags yet. Admins add them in Settings → Customers.</span>}
    </fieldset>
  );
}

export type TagFilterState = { all: string[]; not: string[] };

/** A filter by tags: click once to require a tag, twice to exclude it, again to clear. */
export function TagFilter({ value, onChange, tags, label = "Tags", requireOnly }: { value: TagFilterState; onChange: (v: TagFilterState) => void; tags: Tag[]; label?: string; requireOnly?: boolean }) {
  if (!tags.length) return null;
  const cycle = (id: string) => {
    if (requireOnly) onChange({ all: value.all.includes(id) ? value.all.filter((x) => x !== id) : [...value.all, id], not: [] });
    else if (value.all.includes(id)) onChange({ all: value.all.filter((x) => x !== id), not: [...value.not, id] });
    else if (value.not.includes(id)) onChange({ all: value.all, not: value.not.filter((x) => x !== id) });
    else onChange({ all: [...value.all, id], not: value.not });
  };
  return (
    <fieldset className="tag-picker tag-filter">
      <legend>{label} <span className="muted">{requireOnly ? "(click to require)" : "(click: has it · again: doesn't · again: either)"}</span></legend>
      {tags.filter((t) => !t.archived).map((t) => {
        const state = value.all.includes(t.id) ? "on" : value.not.includes(t.id) ? "not" : "";
        return (
          <button key={t.id} type="button" className={`tag tag-${t.color} tag-toggle ${state}`} aria-label={`${t.name}: ${state === "on" ? "has it" : state === "not" ? "doesn't have it" : "either"}`} onClick={() => cycle(t.id)}>
            {state === "on" ? "✓ " : state === "not" ? "✕ " : ""}{t.name}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Query-string parts for a tag filter (`prefix` "customer" makes customerTags=…). */
export function tagQuery(v: TagFilterState, prefix?: "customer") {
  const out: string[] = [];
  if (v.all.length) out.push(`${prefix ? "customerTags" : "tags"}=${v.all.join(",")}`);
  if (v.not.length && !prefix) out.push(`notTags=${v.not.join(",")}`);
  return out;
}

const blank = (v: unknown) => (v == null ? "" : String(v));
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));

export interface CustomerFormValue {
  kind: string; firstName: string; lastName: string; companyName: string; email: string; phone: string; altPhone: string;
  billingStreet: string; billingCity: string; billingState: string; billingZip: string; delivery: string[]; source: string;
  poRequired: boolean; notes: string; status: string; tagIds: string[]; contacts: CustomerContactInput[];
  custom: CustomValues; newRecord: boolean;
  taxExempt: boolean; taxExemptNumber: string; taxRate: string;
  title: string; county: string; discountPercent: string; termsDays: string; invoiceNotes: string;
}

export function customerFormValue(c?: any): CustomerFormValue {
  return {
    kind: c?.kind ?? "residential", firstName: blank(c?.firstName), lastName: blank(c?.lastName), companyName: blank(c?.companyName),
    email: blank(c?.email), phone: blank(c?.phone), altPhone: blank(c?.altPhone), billingStreet: blank(c?.billingStreet),
    billingCity: blank(c?.billingCity), billingState: c?.billingState ?? "OK", billingZip: blank(c?.billingZip), delivery: c?.delivery ?? ["email"],
    source: blank(c?.source), poRequired: !!c?.poRequired, notes: blank(c?.notes), status: c?.status === "lead" ? "lead" : "active",
    tagIds: c?.tagIds ?? [], contacts: (c?.contacts ?? []).map((k: any) => ({ name: k.name, relation: k.relation ?? "", email: k.email ?? "", phone: k.phone ?? "", getsInvoices: !!k.getsInvoices })),
    custom: c?.custom ?? {}, newRecord: !c,
    taxExempt: !!c?.taxExempt, taxExemptNumber: blank(c?.taxExemptNumber), taxRate: c?.taxRate != null ? String(c.taxRate) : "",
    title: blank(c?.title), county: blank(c?.county), discountPercent: c?.discountPercent ? String(c.discountPercent) : "",
    termsDays: c?.termsDays != null ? String(c.termsDays) : "", invoiceNotes: blank(c?.invoiceNotes),
  };
}

/** Name, contact details, billing address, delivery, source, tags and extra contacts. */
export function CustomerFields({ value, onChange, tags, showStatus }: { value: CustomerFormValue; onChange: (v: CustomerFormValue) => void; tags: Tag[]; showStatus?: boolean }) {
  const set = (patch: Partial<CustomerFormValue>) => onChange({ ...value, ...patch });
  const text = (key: keyof CustomerFormValue, label: string, props: Record<string, unknown> = {}) => (
    <label>{label}<input value={value[key] as string} onChange={(e) => set({ [key]: e.target.value } as Partial<CustomerFormValue>)} {...props} /></label>
  );
  const phone = (key: "phone" | "altPhone", label: string) => (
    <label>{label}<input type="tel" value={value[key]} onChange={(e) => set({ [key]: formatPhoneTyping(e.target.value) })} autoComplete="off" /></label>
  );
  const setContact = (i: number, patch: Partial<CustomerContactInput>) => set({ contacts: value.contacts.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  return (
    <div className="stack">
      <div className="formgrid">
        <label>Type
          <select value={value.kind} onChange={(e) => set({ kind: e.target.value })}>
            {CUSTOMER_KINDS.map((k) => <option key={k} value={k}>{CUSTOMER_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        {value.kind !== "residential" && text("companyName", value.kind === "hoa" ? "HOA name" : "Company name", { required: true })}
        {text("title", "Title", { placeholder: "Mr., Mrs., Dr.", maxLength: 20 })}
        {text("firstName", value.kind === "residential" ? "First name" : "Contact first name", { autoComplete: "off" })}
        {text("lastName", value.kind === "residential" ? "Last name" : "Contact last name", { autoComplete: "off" })}
        {value.kind === "residential" && text("companyName", "Company (optional)")}
        {showStatus && (
          <label>Status
            <select value={value.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="active">Active customer</option>
              <option value="lead">Lead (hasn&apos;t bought yet)</option>
            </select>
          </label>
        )}
      </div>
      <div className="formgrid">
        {text("email", "Email", { type: "email", autoComplete: "off" })}
        {phone("phone", "Phone")}
        {phone("altPhone", "Other phone")}
        <label>How they heard about us
          <input list="lead-sources" value={value.source} onChange={(e) => set({ source: e.target.value })} />
          <datalist id="lead-sources">{LEAD_SOURCES.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
      </div>
      <div className="formgrid">
        {text("billingStreet", "Billing address")}
        {text("billingCity", "City")}
        {text("billingState", "State", { maxLength: 2 })}
        {text("billingZip", "ZIP", { inputMode: "numeric" })}
        {text("county", "County", { maxLength: 60 })}
      </div>
      <fieldset className="checks">
        <legend>Send invoices and estimates by</legend>
        {DELIVERY_METHODS.map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={value.delivery.includes(m)} onChange={(e) => set({ delivery: e.target.checked ? [...value.delivery, m] : value.delivery.filter((x) => x !== m) })} />
            {DELIVERY_LABELS[m]}
          </label>
        ))}
        {value.kind !== "residential" && (
          <label className="check"><input type="checkbox" checked={value.poRequired} onChange={(e) => set({ poRequired: e.target.checked })} /> Needs a PO number on invoices</label>
        )}
      </fieldset>
      <fieldset className="contacts">
        <legend>Sales tax</legend>
        <label className="check"><input type="checkbox" checked={value.taxExempt} onChange={(e) => set({ taxExempt: e.target.checked })} /> Tax exempt <span className="muted">(an HOA, church, school or reseller: no sales tax on their invoices)</span></label>
        <div className="formgrid">
          {value.taxExempt
            ? <label>Exemption certificate number<input maxLength={60} value={value.taxExemptNumber} onChange={(e) => set({ taxExemptNumber: e.target.value })} placeholder="Optional" /></label>
            : <label>Their own tax rate (%)<input inputMode="decimal" value={value.taxRate} onChange={(e) => set({ taxRate: e.target.value })} placeholder="Blank: the property's, else the company's" /></label>}
        </div>
      </fieldset>
      <fieldset className="contacts">
        <legend>Their invoices and estimates <span className="muted">(defaults for new ones)</span></legend>
        <div className="formgrid">
          <label>Discount %<input inputMode="decimal" value={value.discountPercent} onChange={(e) => set({ discountPercent: e.target.value })} placeholder="0" /></label>
          <label>Days to pay<input inputMode="numeric" value={value.termsDays} onChange={(e) => set({ termsDays: e.target.value })} placeholder="Blank: your usual terms" /></label>
        </div>
        <label>Notes on their invoices<textarea rows={2} maxLength={2000} value={value.invoiceNotes} onChange={(e) => set({ invoiceNotes: e.target.value })} placeholder="e.g. Gate code 1234. Bill to the HOA office." /></label>
      </fieldset>
      <TagPicker value={value.tagIds} onChange={(tagIds) => set({ tagIds })} tags={tags} />
      <label>Notes<textarea rows={2} value={value.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      <fieldset className="contacts">
        <legend>Other contacts <span className="muted">(spouse, property manager, accounts payable)</span></legend>
        {value.contacts.map((k, i) => (
          <div key={i} className="formgrid contact-row">
            <label>Name<input value={k.name} required onChange={(e) => setContact(i, { name: e.target.value })} /></label>
            <label>Relation<input value={k.relation ?? ""} onChange={(e) => setContact(i, { relation: e.target.value })} placeholder="Spouse" /></label>
            <label>Email<input type="email" value={k.email ?? ""} onChange={(e) => setContact(i, { email: e.target.value })} /></label>
            <label>Phone<input type="tel" value={k.phone ?? ""} onChange={(e) => setContact(i, { phone: formatPhoneTyping(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={k.getsInvoices} onChange={(e) => setContact(i, { getsInvoices: e.target.checked })} /> Copy on invoices</label>
            <button type="button" className="btn" onClick={() => set({ contacts: value.contacts.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => set({ contacts: [...value.contacts, { name: "", relation: "", email: "", phone: "", getsInvoices: false }] })}>Add a contact</button>
      </fieldset>
      <CustomFieldInputs target="customer" values={value.custom} onChange={(custom) => set({ custom })} fresh={value.newRecord} />
    </div>
  );
}

/** The form value as the API wants it (blank strings left out). */
export function customerBody(v: CustomerFormValue) {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== ""));
  return {
    ...strip({ ...v, contacts: undefined, newRecord: undefined, taxRate: undefined, taxExemptNumber: undefined, discountPercent: undefined, termsDays: undefined }), contacts: v.contacts.map((k) => strip(k as Record<string, unknown>)),
    discountPercent: Number(v.discountPercent) || 0, termsDays: v.termsDays.trim() === "" ? null : Number(v.termsDays),
    // Blank clears these.
    taxRate: v.taxRate.trim() === "" ? null : Number(v.taxRate), taxExemptNumber: v.taxExempt && v.taxExemptNumber.trim() ? v.taxExemptNumber.trim() : null,
  };
}

export interface PropertyFormValue {
  name: string; street: string; city: string; state: string; zip: string; mapCode: string; frontSqFt: string; backSqFt: string; lawnSqFt: string;
  measurementId: string | null; measurementName: string; gateCode: string; pets: string; accessNotes: string; notes: string; tagIds: string[];
  lat: number | null; lng: number | null; custom: CustomValues; newRecord: boolean; taxRate: string;
}

export function propertyFormValue(p?: any): PropertyFormValue {
  return {
    name: blank(p?.name), street: blank(p?.street), city: blank(p?.city), state: p?.state ?? "OK", zip: blank(p?.zip), mapCode: blank(p?.mapCode),
    frontSqFt: blank(p?.frontSqFt != null ? Math.round(p.frontSqFt) : ""), backSqFt: blank(p?.backSqFt != null ? Math.round(p.backSqFt) : ""),
    lawnSqFt: blank(p?.lawnSqFt != null && p?.frontSqFt == null && p?.backSqFt == null ? Math.round(p.lawnSqFt) : ""),
    measurementId: p?.measurementId ?? null, measurementName: p?.measurement?.name ?? "", gateCode: blank(p?.gateCode), pets: blank(p?.pets),
    accessNotes: blank(p?.accessNotes), notes: blank(p?.notes), tagIds: p?.tagIds ?? [], lat: p?.lat ?? null, lng: p?.lng ?? null,
    custom: p?.custom ?? {}, newRecord: !p, taxRate: p?.taxRate != null ? String(p.taxRate) : "",
  };
}

export function propertyBody(v: PropertyFormValue) {
  const front = num(v.frontSqFt), back = num(v.backSqFt), total = num(v.lawnSqFt);
  const out: Record<string, unknown> = {
    street: v.street, state: v.state || "OK", tagIds: v.tagIds, frontSqFt: front, backSqFt: back, lawnSqFt: front == null && back == null ? total : null,
    measurementId: v.measurementId, lat: v.lat, lng: v.lng, custom: v.custom, taxRate: v.taxRate.trim() === "" ? null : Number(v.taxRate),
  };
  for (const k of ["name", "city", "zip", "mapCode", "gateCode", "pets", "accessNotes", "notes"] as const) if (v[k].trim()) out[k] = v[k];
  return out;
}

/** Address, Map Code, lawn size (typed, or from a saved Property Measure), access details and tags. */
export function PropertyFields({ value, onChange, tags }: { value: PropertyFormValue; onChange: (v: PropertyFormValue) => void; tags: Tag[] }) {
  const set = (patch: Partial<PropertyFormValue>) => onChange({ ...value, ...patch });
  const text = (key: keyof PropertyFormValue, label: string, props: Record<string, unknown> = {}) => (
    <label>{label}<input value={value[key] as string} onChange={(e) => set({ [key]: e.target.value } as Partial<PropertyFormValue>)} {...props} /></label>
  );
  const total = lawnTotal({ frontSqFt: num(value.frontSqFt), backSqFt: num(value.backSqFt), lawnSqFt: num(value.lawnSqFt) });
  return (
    <div className="stack">
      <div className="formgrid">
        {text("street", "Service address", { required: true, autoComplete: "off" })}
        {text("city", "City")}
        {text("state", "State", { maxLength: 2 })}
        {text("zip", "ZIP", { inputMode: "numeric" })}
        {text("name", "Label (optional)", { placeholder: "Rental A, Clubhouse…" })}
        {text("mapCode", "Map Code (MC)", { placeholder: "e.g. 801" })}
      </div>
      <MeasurementPicker value={value} onPick={(m) => set(m ? {
        measurementId: m.id, measurementName: m.name,
        frontSqFt: m.frontSqFt != null ? String(Math.round(m.frontSqFt)) : "", backSqFt: m.backSqFt != null ? String(Math.round(m.backSqFt)) : "",
        lawnSqFt: m.frontSqFt == null && m.backSqFt == null ? String(Math.round(m.netSqFt)) : "",
        lat: value.lat ?? m.lat, lng: value.lng ?? m.lng,
      } : { measurementId: null, measurementName: "" })} />
      <div className="formgrid">
        {text("frontSqFt", "Front lawn (sq ft)", { inputMode: "numeric" })}
        {text("backSqFt", "Back lawn (sq ft)", { inputMode: "numeric" })}
        {!value.frontSqFt && !value.backSqFt ? text("lawnSqFt", "Total lawn (sq ft)", { inputMode: "numeric" }) : (
          <label>Total lawn<input readOnly value={total != null ? `${total.toLocaleString()} sq ft` : ""} /></label>
        )}
      </div>
      <div className="formgrid">
        {text("gateCode", "Gate code")}
        {text("pets", "Pets", { placeholder: "Dog in back yard" })}
        {text("taxRate", "Sales tax rate here (%)", { inputMode: "decimal", placeholder: "Blank: the customer's, else the company's" })}
      </div>
      <label>Access notes<textarea rows={2} value={value.accessNotes} onChange={(e) => set({ accessNotes: e.target.value })} /></label>
      <TagPicker value={value.tagIds} onChange={(tagIds) => set({ tagIds })} tags={tags} label="Property tags" />
      <CustomFieldInputs target="property" values={value.custom} onChange={(custom) => set({ custom })} fresh={value.newRecord} />
      <label>Notes (for internal use)<textarea rows={2} value={value.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
    </div>
  );
}

/** Picks a saved Property Measure to take the lawn size from. */
function MeasurementPicker({ value, onPick }: { value: PropertyFormValue; onPick: (m: any | null) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api<any[]>(`/measurements?q=${encodeURIComponent(q || value.street)}`).then(setResults, () => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, open, value.street]);
  if (value.measurementId && !open) {
    return (
      <div className="row muted">Lawn size from saved measurement <strong>{value.measurementName || "(linked)"}</strong>
        <button type="button" className="btn" onClick={() => setOpen(true)}>Change</button>
        <button type="button" className="btn" onClick={() => onPick(null)}>Unlink</button>
      </div>
    );
  }
  if (!open) return <div><button type="button" className="btn" onClick={() => setOpen(true)}>Use a saved Property Measure</button></div>;
  return (
    <div className="card inset stack">
      <label>Find a saved measurement<input type="search" autoFocus value={q} placeholder={value.street || "Name or address"} onChange={(e) => setQ(e.target.value)} /></label>
      {results.length ? (
        <ul className="pick-list">
          {results.slice(0, 8).map((m) => (
            <li key={m.id}><button type="button" className="linkish" onClick={() => { onPick(m); setOpen(false); }}>
              <strong>{m.name}</strong> <span className="muted">{m.address ?? ""} · {Math.round(m.netSqFt).toLocaleString()} sq ft</span>
            </button></li>
          ))}
        </ul>
      ) : <p className="muted">No saved measurements match. Measure it on the <Link href="/measure">Property Measure</Link> page first.</p>}
      <div><button type="button" className="btn" onClick={() => setOpen(false)}>Close</button></div>
    </div>
  );
}

/** Search for a customer by name or email and pick one. */
export function CustomerPicker({ onPick, label = "Customer", exclude = [] }: { onPick: (c: { id: string; name: string }) => void; label?: string; exclude?: string[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => api<any[]>(`/properties/customer-search?q=${encodeURIComponent(q)}`).then(setResults, () => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = results.filter((r) => !exclude.includes(r.id));
  return (
    <div className="stack">
      <label>{label}<input type="search" value={q} placeholder="Type a name or email" onChange={(e) => setQ(e.target.value)} /></label>
      {q.trim().length >= 2 && (list.length ? (
        <ul className="pick-list">
          {list.map((c) => (
            <li key={c.id}><button type="button" className="linkish" onClick={() => { onPick(c); setQ(""); }}>
              <strong>{c.name}</strong> <span className="muted">#{c.number}{c.email ? ` · ${c.email}` : ""}{c.status === "lead" ? " · lead" : ""}</span>
            </button></li>
          ))}
        </ul>
      ) : <p className="muted">No customers match.</p>)}
    </div>
  );
}

/** Cancelling asks for a reason from the list, an effective date and an optional comment. */
export function CancelForm({ what, note, onSubmit, onClose }: { what: string; note?: ReactNode; onSubmit: (body: { reasonId: string; effectiveDate?: string; comment?: string }) => Promise<unknown>; onClose: () => void }) {
  const reasons = useApi<any[]>("/crm/cancel-reasons");
  const [reasonId, setReasonId] = useState("");
  const [date, setDate] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reason = reasons.data?.find((r) => r.id === reasonId);
  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try { await onSubmit({ reasonId, ...(date ? { effectiveDate: date } : {}), ...(comment.trim() ? { comment } : {}) }); onClose(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Cancel {what}</h2>
      {note && <p className="muted" style={{ margin: 0 }}>{note}</p>}
      <div className="formgrid">
        <label>Reason
          <select required value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
            <option value="">Choose a reason…</option>
            {(reasons.data ?? []).filter((r) => !r.retired).map((r) => <option key={r.id} value={r.id}>{r.label}{r.initiatedBy === "company" ? " (our decision)" : ""}</option>)}
          </select>
        </label>
        <label>Effective date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <label>Comment{reason?.commentRequired ? " (required)" : ""}<textarea rows={2} required={!!reason?.commentRequired} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn danger" disabled={busy}>Cancel {what}</button>
        <button type="button" className="btn" onClick={onClose}>Keep</button>
      </div>
    </form>
  );
}

export const TAG_COLOR_CHOICES = TAG_COLORS;
