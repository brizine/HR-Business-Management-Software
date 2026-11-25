"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TODO_COLOR, MONTH_SHORT, PRIORITIES, PRIORITY_LABELS, REPEAT_UNITS, TODO_COLORS, VISIT_BILLING, VISIT_BILLING_LABELS, VISIT_SCHEDULING, VISIT_SCHEDULING_LABELS,
  describePricing, formatMoney, formatTodoTime, isInactive, lineAmount, lineTaxRate, packageToLines, priceFor, taxFor as taxForLines, taxRateFor, visitDates, visitLineHours, visitNumber,
  type CustomValues, type Priority, type RepeatUnit, type VisitBilling, type VisitScheduling,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { VisitFormsPicker, type WorkOrderForm } from "./visit-forms";
import { CustomerPicker, TagChip, TagPicker, useTags } from "./customers";
import { Icon } from "./icons";
import { useBillingSettings } from "./invoices";
import { CustomFieldInputs } from "./custom-fields";
import { ChemicalsStep, loadChemicalOptions, type ChemicalOptions } from "@/components/chemicals-step";
import { ErrorBox } from "./ui";

export interface VisitLine { id?: string; serviceTypeId: string | null; description: string; quantity: number; budgetedHours: number | null; unitPriceCents: number | null; amountCents: number | null; taxRate?: number }
export interface Visit {
  id: string; number: number; title: string; color: string; location: string | null; billing: VisitBilling;
  date: string | null; endDate: string | null; startTime: string | null; endTime: string | null; budgetedHours: number | null; totalCents: number | null;
  status: "open" | "on_site" | "completed" | "skipped"; statusLabel: string; startedAt: string | null; completedAt: string | null; skippedAt: string | null;
  skipReason: string | null; notes: string | null; completionNotes: string | null; seriesId: string | null; repeatLabel: string | null;
  customerId: string; propertyId: string | null; invoiceId: string | null; invoiced: boolean | null; trackedMinutes: number | null;
  crewId: string | null; crew: { id: string; name: string; color: string } | null;
  tagIds: string[]; tags: { id: string; name: string; color: string }[]; fileCount: number; custom: CustomValues;
  customer: { id: string; name: string; phone: string | null };
  property: { id: string; name: string | null; address: string; gateCode: string | null; pets: string | null; accessNotes: string | null; lawnSqFt: number | null; lat: number | null; lng: number | null; custom?: CustomValues } | null;
  invoice: { id: string; number: number | null; status: string } | null;
  lines: VisitLine[]; assignees: { id: string; firstName: string; lastName: string }[];
  finishedBy: string | null; createdBy: string | null;
  /** Its visit forms (Marketing → Visit Forms), and whether each has been submitted. */
  forms?: WorkOrderForm[];
  /** The waiting-list window (see the Waiting list page). */
  releaseOn?: string | null; dueBy?: string | null; minDaysAfterLast?: number | null; priority?: Priority; windowStart?: string | null; windowEnd?: string | null;
  earlyReason?: string | null; backReason?: string | null;
}

export const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
export const visitWhen = (v: Pick<Visit, "date" | "endDate" | "startTime" | "endTime">) =>
  !v.date ? "Waitlist (no date yet)" : [v.endDate ? `${dayLabel(v.date)} – ${dayLabel(v.endDate)}` : dayLabel(v.date), formatTodoTime(v.startTime, v.endTime)].filter(Boolean).join(" · ");
export const crewNames = (v: Pick<Visit, "assignees"> & { crew?: Visit["crew"] }) => {
  const people = v.assignees.map((a) => `${a.firstName} ${a.lastName}`).join(", ");
  return v.crew ? `${v.crew.name}${people ? ` (${people})` : ""}` : people;
};
const TONE: Record<string, string> = { open: "", on_site: "warn", completed: "ok", skipped: "bad" };
export function VisitStatus({ v }: { v: Pick<Visit, "status" | "statusLabel"> }) {
  return <span className={`badge ${TONE[v.status] ?? ""}`}>{v.statusLabel}</span>;
}
export const trackedLabel = (m: number | null) => (m == null ? null : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const toCents = (s: string) => { const n = Number(String(s).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };

/** Arrived / Done / Skip (and Undo) for the crew and the office. */
export function CrewButtons({ v, onChange, compact }: { v: Visit; onChange: (v: Visit) => void; compact?: boolean }) {
  const act = useAction();
  const [mode, setMode] = useState<null | "complete" | "skip">(null);
  const [text, setText] = useState("");
  const [chem, setChem] = useState<ChemicalOptions | null>(null);
  const run = (path: string, body?: unknown) => act.run(async () => { onChange(await api<Visit>(`/visits/${v.id}/${path}`, { method: "POST", body: body ?? {} })); setMode(null); setText(""); setChem(null); });
  // Completed: a chemical work order asks what was applied (the same step as the phone's).
  const startComplete = () => act.run(async () => {
    const o = await loadChemicalOptions(v.id);
    setChem(o.chemical ? o : null);
    setMode("complete");
  });
  if (mode === "complete" && chem) {
    return (
      <ChemicalsStep options={chem} busy={act.busy} error={act.error}
        onSave={(notes, chemicals) => run("complete", { notes: notes.trim() || undefined, chemicals })}
        onCancel={() => { setMode(null); setChem(null); }} />
    );
  }
  if (mode) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        <label>{mode === "complete" ? "Notes about the work (optional)" : "Why was it skipped?"}
          <textarea value={text} autoFocus onChange={(e) => setText(e.target.value)} placeholder={mode === "complete" ? "Applied round 3; back gate was open" : "Rain, locked gate, customer asked to wait…"} />
        </label>
        <div className="row">
          <button type="button" className="btn primary" disabled={act.busy || (mode === "skip" && !text.trim())} onClick={() => run(mode, mode === "complete" ? { notes: text } : { reason: text })}>{mode === "complete" ? "Mark completed" : "Skip it"}</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </div>
        <ErrorBox error={act.error} />
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 6 }}>
      {v.status === "open" && <button type="button" className={compact ? "btn" : "btn"} disabled={act.busy} onClick={() => run("start")}>Arrived (on site)</button>}
      {(v.status === "open" || v.status === "on_site") && <button type="button" className="btn primary" disabled={act.busy} onClick={startComplete}>Completed</button>}
      {(v.status === "open" || v.status === "on_site") && <button type="button" className="btn" disabled={act.busy} onClick={() => setMode("skip")}>Skip</button>}
      {(v.status === "completed" || v.status === "skipped") && !v.invoiced && <button type="button" className="btn" disabled={act.busy} onClick={() => run("reopen")}>Undo ({v.status === "completed" ? "not done" : "not skipped"})</button>}
      <ErrorBox error={act.error} />
    </div>
  );
}

type LineDraft = { serviceTypeId: string | null; description: string; quantity: string; hours: string; price: string; tax: string };
const taxText = (r: number | null | undefined) => (r ? String(Number(r.toFixed(3))) : "");
const draftLine = (l?: VisitLine): LineDraft => ({ serviceTypeId: l?.serviceTypeId ?? null, description: l?.description ?? "", quantity: l ? String(l.quantity) : "1", hours: l?.budgetedHours != null ? String(l.budgetedHours) : "", price: dollars(l?.unitPriceCents), tax: taxText(l?.taxRate) });

/**
 * New or changed work order, laid out like Homeworks' visit form: title; customer, property, color and
 * location; billing; line items from the price list (priced for the lawn); scheduling (single,
 * repeating with an off-season, or the waitlist); crew; notes.
 */
export function VisitForm({ visit, preset, onSaved, onCancel }: {
  visit?: Visit;
  /** Starts filled in (from a customer or property page, a calendar day, or an accepted estimate). */
  preset?: { customer?: { id: string; name: string }; propertyId?: string; date?: string; title?: string; lines?: Partial<VisitLine>[]; estimateId?: string; notes?: string };
  onSaved: (v: Visit, created: number) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(visit?.title ?? preset?.title ?? "");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(visit ? { id: visit.customer.id, name: visit.customer.name } : preset?.customer ?? null);
  const [propertyId, setPropertyId] = useState(visit?.propertyId ?? preset?.propertyId ?? "");
  const [color, setColor] = useState(visit?.color ?? DEFAULT_TODO_COLOR);
  const [location, setLocation] = useState(visit?.location ?? "");
  const [billing, setBilling] = useState<VisitBilling>(visit?.billing ?? "invoice");
  const [lines, setLines] = useState<LineDraft[]>(visit?.lines.length ? visit.lines.map(draftLine) : preset?.lines?.length ? preset.lines.map((l) => draftLine(l as VisitLine)) : [draftLine()]);
  const [scheduling, setScheduling] = useState<VisitScheduling>(visit && !visit.date ? "waitlist" : "single");
  const [date, setDate] = useState(visit?.date ?? preset?.date ?? localToday());
  const [multi, setMulti] = useState(!!visit?.endDate);
  const [endDate, setEndDate] = useState(visit?.endDate ?? plusDays(visit?.date ?? preset?.date ?? localToday(), 1));
  const [timed, setTimed] = useState(!!visit?.startTime);
  const [startTime, setStartTime] = useState(visit?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(visit?.endTime ?? "");
  const [hours, setHours] = useState(visit?.budgetedHours != null && visit.budgetedHours !== visitLineHours(visit.lines) ? String(visit.budgetedHours) : "");
  const [every, setEvery] = useState("6");
  const [unit, setUnit] = useState<RepeatUnit>("week");
  const [until, setUntil] = useState(plusDays(date, 180));
  const [offMonths, setOffMonths] = useState<number[]>([]);
  const [crew, setCrew] = useState<string[]>(visit?.assignees.map((a) => a.id) ?? []);
  const [crewId, setCrewId] = useState(visit?.crewId ?? "");
  const [tagIds, setTagIds] = useState<string[]>(visit?.tagIds ?? []);
  const { tags } = useTags();
  const [notes, setNotes] = useState(visit?.notes ?? preset?.notes ?? "");
  // The visit forms on it: on a new work order, null until the list says which attach automatically.
  const [formIds, setFormIds] = useState<string[] | null>(visit ? (visit.forms ?? []).map((f) => f.formId).filter((x): x is string => !!x) : null);
  const [custom, setCustom] = useState<CustomValues>(visit?.custom ?? {});
  const [applyTo, setApplyTo] = useState<"one" | "following">("one");
  const [releaseOn, setReleaseOn] = useState(visit?.releaseOn ?? "");
  const [dueBy, setDueBy] = useState(visit?.dueBy ?? "");
  const [minDays, setMinDays] = useState(visit?.minDaysAfterLast != null ? String(visit.minDaysAfterLast) : "");
  const [priority, setPriority] = useState<Priority>(visit?.priority ?? "normal");
  const [windowStart, setWindowStart] = useState(visit?.windowStart ?? "");
  const [windowEnd, setWindowEnd] = useState(visit?.windowEnd ?? "");
  const save = useAction();
  const services = useApi<any[]>("/service-types");
  const detail = useApi<any>(customer ? `/customers/${customer.id}` : null);
  const staff = useApi<any[]>("/employees");
  const crews = useApi<{ id: string; name: string; color: string; memberIds: string[]; active: boolean }[]>("/crews?all=1");
  const pkgs = useApi<{ id: string; name: string; active: boolean; lines: any[] }[]>("/packages");
  const properties: any[] = (detail.data?.properties ?? []).filter((p: any) => !p.endDate);
  const property = properties.find((p) => p.id === propertyId);
  useEffect(() => { if (detail.data && !propertyId && properties.length === 1) setPropertyId(properties[0].id); }, [detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // Sales tax: the rate for this customer and property; taxable items get it.
  const billingSet = useBillingSettings();
  const taxSettings = billingSet.data ?? { taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 };
  const rate = taxRateFor({ settings: taxSettings, customer: detail.data, property });
  const showTax = taxSettings.taxEnabled || lines.some((l) => Number(l.tax) > 0);
  const taxFor = (serviceTypeId: string | null) => taxText(lineTaxRate(services.data?.find((x) => x.id === serviceTypeId)?.taxable, rate));
  const pickService = (i: number, id: string) => {
    if (!id) return setLine(i, { serviceTypeId: null });
    const s = services.data?.find((x) => x.id === id);
    if (!s) return;
    const price = priceFor(s, property?.lawnSqFt ?? null);
    setLine(i, { serviceTypeId: s.id, description: lines[i].description && lines[i].serviceTypeId === null ? lines[i].description : s.name, price: price != null ? dollars(price) : lines[i].price, tax: taxFor(s.id) });
  };
  // A different customer or property: taxable lines take its rate.
  const lastRate = useRef<number | null>(null);
  useEffect(() => {
    if (!billingSet.data || !services.data || (customer && !detail.data)) return;
    if (lastRate.current !== null && lastRate.current !== rate) setLines((ls) => ls.map((l) => (services.data!.find((x) => x.id === l.serviceTypeId)?.taxable ? { ...l, tax: taxText(rate) } : l)));
    lastRate.current = rate;
  }, [rate, billingSet.data, services.data, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Changing the property re-prices the lawn-size services.
  useEffect(() => {
    if (!property || !services.data) return;
    setLines((ls) => ls.map((l) => {
      const s = services.data!.find((x) => x.id === l.serviceTypeId);
      const p = s ? priceFor(s, property.lawnSqFt ?? null) : null;
      return s && s.pricing !== "flat" && p != null ? { ...l, price: dollars(p) } : l;
    }));
  }, [propertyId, services.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = lines.filter((l) => l.description.trim()).map((l) => ({ serviceTypeId: l.serviceTypeId, description: l.description.trim(), quantity: Number(l.quantity) || 0, budgetedHours: l.hours.trim() === "" ? null : Number(l.hours), unitPriceCents: toCents(l.price || "0"), taxRate: Number(l.tax) || 0 }));
  const total = parsed.reduce((s, l) => s + (Number.isFinite(l.unitPriceCents) ? lineAmount(l) : 0), 0);
  const tax = taxForLines(parsed.filter((l) => Number.isFinite(l.unitPriceCents)));
  const lineHours = visitLineHours(parsed);
  const count = scheduling === "repeat" && date && until ? visitDates(date, unit, Number(every) || 1, until, offMonths).length : 1;
  const team = (staff.data ?? []).filter((e) => !isInactive(e.status) || crew.includes(e.id));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      if (parsed.some((l) => !Number.isFinite(l.unitPriceCents))) throw new Error("Check the line item prices");
      const body = {
        title, customerId: customer?.id, propertyId, color, location, billing, lines: parsed, notes,
        date: scheduling === "waitlist" ? null : date, endDate: multi && scheduling === "single" ? endDate : null,
        startTime: timed && scheduling !== "waitlist" ? startTime : null, endTime: timed && scheduling !== "waitlist" ? endTime || null : null,
        budgetedHours: hours.trim() === "" ? null : Number(hours), assigneeIds: crew, crewId: crewId || null, tagIds, custom,
        ...(formIds ? { formIds } : {}),
        releaseOn: releaseOn || null, dueBy: dueBy || null, minDaysAfterLast: minDays ? Number(minDays) : null, priority, windowStart: windowStart || null, windowEnd: windowStart ? windowEnd || null : null,
        ...(visit ? {} : { scheduling, repeatEvery: Number(every) || 1, repeatUnit: unit, repeatUntil: scheduling === "repeat" ? until : null, offMonths, estimateId: preset?.estimateId }),
      };
      const r = visit
        ? await api<Visit & { changed: number }>(`/visits/${visit.id}${visit.seriesId && applyTo === "following" ? "?applyTo=following" : ""}`, { method: "PUT", body })
        : await api<Visit & { created: number }>("/visits", { method: "POST", body });
      onSaved(r, "created" in r ? r.created : 1);
    });
  };

  return (
    <form className="card stack todo-form visit-form" onSubmit={submit}>
      <h2>{visit ? `Edit ${visitNumber(visit.number)}` : "New work order"}</h2>
      <label>Work order title or description *<input required autoFocus={!visit} maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Round 3: fertilizer & weed control" /></label>

      <h3 className="todo-section">Customer</h3>
      <div className="formgrid">
        {customer ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="todo-label">Customer *</span>
            <div className="row"><strong>{customer.name}</strong><button type="button" className="linkbtn" onClick={() => { setCustomer(null); setPropertyId(""); }}>Change</button></div>
          </div>
        ) : <CustomerPicker label="Customer *" onPick={(c) => { setCustomer({ id: c.id, name: c.name }); setPropertyId(""); }} />}
        {customer && (
          <label>Property *
            <select required value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">Pick the property</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.street}{p.name ? ` (${p.name})` : ""}{p.lawnSqFt ? ` · ${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : ""}</option>)}
            </select>
          </label>
        )}
        <label>Location (optional)<input maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Back yard, the HOA entrance…" /></label>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="todo-label">Color</span>
        <div className="todo-colors" role="radiogroup" aria-label="Color">
          {TODO_COLORS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={color.toLowerCase() === c.key} aria-label={c.label} title={c.label} style={{ background: c.key }} onClick={() => setColor(c.key)} />)}
        </div>
      </div>

      <h3 className="todo-section">Billing and line items</h3>
      <label style={{ maxWidth: 320 }}>Billing
        <select value={billing} onChange={(e) => setBilling(e.target.value as VisitBilling)}>
          {VISIT_BILLING.map((b) => <option key={b} value={b}>{VISIT_BILLING_LABELS[b]}</option>)}
        </select>
      </label>
      <div className="tablewrap">
        <table className="invoice-lines visit-lines">
          <thead><tr><th style={{ width: "34%" }}>Item / service</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 100 }}>Budgeted hours</th><th style={{ width: 110 }}>Rate</th>{showTax && <th style={{ width: 90 }}>Tax %</th>}<th style={{ width: 100, textAlign: "right" }}>Total</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const s = services.data?.find((x) => x.id === l.serviceTypeId);
            const unpriced = s && priceFor(s, property?.lawnSqFt ?? null) == null;
            const amount = { quantity: Number(l.quantity) || 0, unitPriceCents: toCents(l.price || "0") };
            return (
              <tr key={i}>
                <td>
                  <select aria-label={`Line ${i + 1} service`} value={l.serviceTypeId ?? ""} onChange={(e) => pickService(i, e.target.value)}>
                    <option value="">Custom item</option>
                    {(services.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" style={{ marginTop: 4 }} />
                  {s && <div className="muted" style={{ fontSize: 12 }}>{describePricing(s)}{unpriced ? " · add the lawn size to price it" : ""}</div>}
                </td>
                <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                <td><input aria-label={`Line ${i + 1} budgeted hours`} inputMode="decimal" placeholder="0" value={l.hours} onChange={(e) => setLine(i, { hours: e.target.value })} /></td>
                <td><input aria-label={`Line ${i + 1} rate`} inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></td>
                {showTax && <td><input aria-label={`Line ${i + 1} tax rate`} inputMode="decimal" placeholder="0" value={l.tax} onChange={(e) => setLine(i, { tax: e.target.value })} /></td>}
                <td style={{ textAlign: "right" }}>{Number.isFinite(amount.unitPriceCents) ? formatMoney(lineAmount(amount)) : "—"}</td>
                <td><button type="button" className="btn" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [draftLine()]))}>✕</button></td>
              </tr>
            );
          })}</tbody>
          <tfoot><tr><td colSpan={2}>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn" onClick={() => setLines((ls) => [...ls, draftLine()])}><Icon name="plus" size={14} /> Add line</button>
              {!!pkgs.data?.length && (
                <select aria-label="Add a package" value="" className="pkg-select" onChange={(e) => {
                  const pkg = pkgs.data?.find((p) => p.id === e.target.value);
                  if (!pkg) return;
                  const added = packageToLines(pkg.lines, services.data ?? [], property?.lawnSqFt ?? null).map((l) => ({
                    serviceTypeId: l.serviceTypeId, description: l.description, quantity: String(l.quantity), hours: l.budgetedHours != null ? String(l.budgetedHours) : "", price: dollars(l.unitPriceCents), tax: taxFor(l.serviceTypeId),
                  }));
                  // An untouched empty first line is replaced.
                  setLines((ls) => [...ls.filter((l) => l.description.trim() || l.price.trim()), ...added]);
                }}>
                  <option value="">Add package…</option>
                  {pkgs.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
          </td>
            <td className="muted">{lineHours ? `${lineHours} h` : ""}</td><td style={{ textAlign: "right" }}><strong>Total</strong></td>
            {showTax && <td className="muted" style={{ fontSize: 12 }}>{tax ? `+${formatMoney(tax)} ${taxSettings.taxName.toLowerCase()}` : ""}</td>}
            <td style={{ textAlign: "right" }}><strong>{formatMoney(total + tax)}</strong></td><td /></tr></tfoot>
        </table>
      </div>

      <h3 className="todo-section">Scheduling</h3>
      <div className="formgrid">
        {!visit ? (
          <label>Scheduling
            <select value={scheduling} onChange={(e) => setScheduling(e.target.value as VisitScheduling)}>
              {VISIT_SCHEDULING.map((s) => <option key={s} value={s}>{VISIT_SCHEDULING_LABELS[s]}</option>)}
            </select>
          </label>
        ) : (
          <label>Scheduling
            <select value={scheduling} onChange={(e) => setScheduling(e.target.value as VisitScheduling)}>
              <option value="single">On a date</option><option value="waitlist">On the waitlist (no date)</option>
            </select>
          </label>
        )}
        {scheduling !== "waitlist" && <label>{scheduling === "repeat" ? "First date" : multi ? "First day" : "Date"}<input type="date" required value={date} onChange={(e) => { setDate(e.target.value); if (endDate <= e.target.value) setEndDate(plusDays(e.target.value, 1)); }} /></label>}
        {multi && scheduling === "single" && <label>Last day<input type="date" required min={date} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>}
        <label>Budgeted hours<input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder={lineHours ? `${lineHours} (from the line items)` : "0"} /></label>
      </div>
      {scheduling !== "waitlist" && (
        <div className="row" style={{ gap: 16 }}>
          {scheduling === "single" && <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> More than one day</label>}
          <label className="check"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Set a time</label>
        </div>
      )}
      {timed && scheduling !== "waitlist" && (
        <div className="formgrid">
          <label>Start time<input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          <label>End time (optional)<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
        </div>
      )}
      <details className="visit-window" open={!!(releaseOn || dueBy || minDays || windowStart || priority !== "normal") || undefined}>
        <summary>Window, priority and appointment time{scheduling === "waitlist" ? " (for the waiting list)" : ""}</summary>
        <div className="formgrid">
          {scheduling === "waitlist" && <label>Eligible from<input type="date" value={releaseOn} onChange={(e) => setReleaseOn(e.target.value)} /><span className="muted field-hint">Its release date; empty means now</span></label>}
          <label>Due by<input type="date" min={releaseOn || undefined} value={dueBy} onChange={(e) => setDueBy(e.target.value)} /><span className="muted field-hint">Flagged as closing 7 days before</span></label>
          <label>Minimum days since the last service<input inputMode="numeric" value={minDays} onChange={(e) => setMinDays(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="e.g. 21" /><span className="muted field-hint">Warns before anyone schedules it sooner</span></label>
          <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select></label>
          <label>Appointment window from<input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} /><span className="muted field-hint">e.g. 13:00 for "after 1 pm"</span></label>
          {windowStart && <label>Until (optional)<input type="time" min={windowStart} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} /></label>}
        </div>
      </details>
      {scheduling === "repeat" && (
        <div className="visit-repeat stack">
          <div className="formgrid">
            <label>Repeat every
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.replace(/\D/g, "").slice(0, 2))} style={{ width: 70 }} aria-label="How many" />
                <select value={unit} onChange={(e) => setUnit(e.target.value as RepeatUnit)} aria-label="Days, weeks, months or years">
                  {REPEAT_UNITS.map((u) => <option key={u} value={u}>{u}{Number(every) === 1 ? "" : "s"}</option>)}
                </select>
              </div>
            </label>
            <label>Until<input type="date" required min={plusDays(date, 1)} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="todo-label">Off-season (no work these months)</span>
            <div className="month-chips" role="group" aria-label="Off-season months">
              {MONTH_SHORT.map((m, i) => (
                <button key={m} type="button" aria-pressed={offMonths.includes(i + 1)} onClick={() => setOffMonths((o) => (o.includes(i + 1) ? o.filter((x) => x !== i + 1) : [...o, i + 1]))}>{m}</button>
              ))}
            </div>
          </div>
          <p className="muted" style={{ margin: 0 }}>{count} work order{count === 1 ? "" : "s"}{total ? `, ${formatMoney(total * count)} in all` : ""}.</p>
        </div>
      )}

      <h3 className="todo-section">Visit Forms</h3>
      <VisitFormsPicker value={formIds} onChange={setFormIds} attached={visit?.forms} />

      <h3 className="todo-section">Crew</h3>
      <label style={{ maxWidth: 320 }}>Crew
        <select value={crewId} onChange={(e) => {
          setCrewId(e.target.value);
          const c = crews.data?.find((x) => x.id === e.target.value);
          if (c) setCrew(c.memberIds);
        }}>
          <option value="">No crew</option>
          {(crews.data ?? []).filter((c) => c.active || c.id === crewId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {!crews.data?.length && <span className="muted" style={{ fontSize: 12 }}>Set up crews on Team → Crews.</span>}
      </label>
      <span className="todo-label">People on it{crewId ? " (the crew's members; add or take off anyone)" : ""}</span>
      <div className="todo-people" role="group" aria-label="Crew">
        {team.map((e) => (
          <label key={e.id} className="check"><input type="checkbox" checked={crew.includes(e.id)} onChange={() => setCrew((c) => (c.includes(e.id) ? c.filter((x) => x !== e.id) : [...c, e.id]))} /> {e.firstName} {e.lastName}{e.title ? <span className="muted"> · {e.title}</span> : null}</label>
        ))}
      </div>
      <TagPicker value={tagIds} onChange={setTagIds} tags={tags} label="Tags (the company's tag list: Settings → Customers)" />
      <label>Notes for the crew (optional)<textarea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, where to start, what to watch for" /></label>
      <CustomFieldInputs target="workorder" values={custom} onChange={setCustom} fresh={!visit} />
      {visit?.seriesId && (
        <div className="row" style={{ gap: 16 }}>
          <label className="check"><input type="radio" checked={applyTo === "one"} onChange={() => setApplyTo("one")} /> Change just this one</label>
          <label className="check"><input type="radio" checked={applyTo === "following"} onChange={() => setApplyTo("following")} /> This one and the later ones that aren&apos;t done</label>
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : visit ? "Save" : count > 1 ? `Create ${count} work orders` : "Create work order"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Customer and property pages: their work orders coming up and done lately, with Add work order. */
export function LinkedVisits({ customerId, propertyId }: { customerId?: string; propertyId?: string }) {
  const { can } = useAuth();
  const q = customerId ? `customerId=${customerId}` : `propertyId=${propertyId}`;
  const coming = useApi<{ today: string; items: Visit[] }>(`/visits?${q}&status=active`);
  const recent = useApi<{ items: Visit[] }>(`/visits?${q}&order=recent&limit=6`);
  if (!can("manager", "customers")) return null;
  const done = (recent.data?.items ?? []).filter((v) => v.status === "completed" || v.status === "skipped").slice(0, 5);
  const upcoming = coming.data?.items ?? [];
  const row = (v: Visit) => (
    <li key={v.id} className="visit-row" style={{ borderLeftColor: v.color }}>
      <div style={{ minWidth: 0 }}>
        <Link href={`/visits/${v.id}`}><strong>{visitNumber(v.number)}</strong> {v.title}</Link>
        <div className="muted" style={{ fontSize: 13 }}>{[visitWhen(v), crewNames(v) || "No crew", v.totalCents != null ? formatMoney(v.totalCents) : null].filter(Boolean).join(" · ")}</div>
      </div>
      <VisitStatus v={v} />
    </li>
  );
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Work orders{upcoming.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {upcoming.length} open</span> : null}</h2>
        <Link className="btn" href={`/visits/new?${customerId ? `customerId=${customerId}` : ""}${propertyId ? `&propertyId=${propertyId}` : ""}`}><Icon name="plus" size={14} /> Add work order</Link>
      </div>
      {upcoming.length || done.length ? (
        <ul className="visit-list">
          {upcoming.slice(0, 8).map(row)}
          {upcoming.length > 8 && <li className="muted">and {upcoming.length - 8} more…</li>}
          {done.length > 0 && <li className="menu-heading" style={{ paddingLeft: 0 }}>Done lately</li>}
          {done.map(row)}
        </ul>
      ) : coming.data ? <p className="muted" style={{ margin: "8px 0 0" }}>No work orders yet.</p> : null}
    </div>
  );
}

/** A work order's tags as colored chips. */
export function VisitTags({ v }: { v: Pick<Visit, "tags"> }) {
  if (!v.tags?.length) return null;
  return <span className="tag-list">{v.tags.map((t) => <TagChip key={t.id} tag={t as any} />)}</span>;
}

