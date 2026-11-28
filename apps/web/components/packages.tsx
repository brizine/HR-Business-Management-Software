"use client";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  PACKAGE_RENEWALS, PACKAGE_RENEWAL_LABELS, PROPERTY_PACKAGE_STATUS_LABELS, describePricing, formatAddress, formatMoney, lineAmount, packageToLines, roundMissed, visitNumber,
  type PackageRenewal, type PropertyPackageStatus,
} from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { CustomerPicker } from "./customers";
import { Icon } from "./icons";
import { dollars, toCents, useServices } from "./invoices";
import { Empty, ErrorBox } from "./ui";

export interface PackageRound { id?: string; name: string; description?: string; serviceTypeId: string | null; quantity?: number; startDate: string | null; endDate: string | null; minDays: number | null; budgetedHours: number | null; unitPriceCents: number | null; notes: string | null }
export interface Package { id: string; name: string; description: string | null; renewalDate: string | null; active: boolean; startDate: string | null; endDate: string | null; propertyCount: number; rounds: PackageRound[] }
type OnPackage = { id: string; status: PropertyPackageStatus; renewal: PackageRenewal; property: { id: string; address: string; mapCode: string | null }; customer: { id: string; name: string }; crew: { id: string; name: string } | null; totalCents: number };

const STATUS_TONE: Record<PropertyPackageStatus, string> = { active: "ok", paused: "warn", cancelled: "" };

/**
 * Packages: season programs (like Service Autopilot's master packages). Each is a list of rounds,
 * a price-list service with the window it's done in. On the Products & services page; they're put
 * on a property with Add work order → Package Work Order (or Add package on the customer's page).
 */
export function PackagesCard() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const list = useApi<Package[]>("/packages?all=1");
  const services = useServices(true);
  const [show, setShow] = useState<"active" | "inactive" | "all">("active");
  const [editing, setEditing] = useState<Package | "new" | null>(null);
  const copy = useAction();
  const rows = (list.data ?? []).filter((p) => show === "all" || p.active === (show === "active"));
  const inactive = (list.data ?? []).filter((p) => !p.active).length;
  return (
    <div className="card" id="packages">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Packages</h2>
          <p className="muted" style={{ margin: "2px 0 0" }}>Season programs: a list of rounds, each a service with the dates it&apos;s done between. Put one on a property (<strong>Add work order</strong> on the property&apos;s page, then <strong>Package Work Order</strong>) and every round goes on the waiting list in its window.</p>
        </div>
        {admin && !editing && <button className="btn" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> Add package</button>}
      </div>
      {editing && <div style={{ marginTop: 12 }}><PackageForm key={editing === "new" ? "new" : editing.id} pkg={editing === "new" ? null : editing} onDone={() => { setEditing(null); list.reload(); }} /></div>}
      <ErrorBox error={copy.error} />
      <div className="tabs" role="tablist" aria-label="Packages" style={{ margin: "12px 0 4px" }}>
        {(["active", "inactive", "all"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={show === k} onClick={() => setShow(k)}>{k === "active" ? "Active" : k === "inactive" ? `Inactive${inactive ? ` (${inactive})` : ""}` : "All"}</button>
        ))}
      </div>
      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Package</th><th>Rounds</th><th>Start</th><th>End</th><th>Renewal</th><th>Properties</th>{admin && <th />}</tr></thead>
            <tbody>{rows.map((p) => {
              const noWindow = p.rounds.some((r) => !r.startDate || !r.endDate || !r.serviceTypeId);
              return (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.65 }}>
                  <td>
                    <strong>{p.name}</strong>{!p.active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
                    {noWindow && <span className="badge warn" style={{ marginLeft: 6 }} title="From before packages had rounds with dates. Edit it and give each round a service and a window, or delete it.">needs dates</span>}
                    {p.description && <div className="muted">{p.description}</div>}
                  </td>
                  <td title={p.rounds.map((r) => `${r.name}: ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`).join("\n")}>{p.rounds.length}</td>
                  <td>{fmtDate(p.startDate)}</td>
                  <td>{fmtDate(p.endDate)}</td>
                  <td>{fmtDate(p.renewalDate)}</td>
                  <td>{p.propertyCount || <span className="muted">0</span>}</td>
                  {admin && (
                    <td className="row">
                      <button className="btn" onClick={() => setEditing(p)}>Edit</button>
                      <button className="btn" disabled={copy.busy} title="Start a new package with the same rounds" onClick={() => copy.run(async () => { const made = await api<Package>(`/packages/${p.id}/copy`, { method: "POST" }); await list.reload(); setEditing(made); })}>Copy</button>
                    </td>
                  )}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : list.data && !editing ? <Empty>{show === "active" ? <>No packages yet.{admin ? " For example a lawn program: Early Spring, Spring, Early Summer, Summer, Early Fall and Fall." : " An admin adds them."}</> : "None."}</Empty> : null}
      {!services.loading && !services.list.length && admin && <p className="muted">Add your services above first: every round of a package is one of them.</p>}
    </div>
  );
}

type RoundDraft = { id?: string; name: string; serviceTypeId: string; startDate: string; endDate: string; minDays: string; hours: string; price: string; notes: string; showNotes: boolean };
const roundDraft = (r?: PackageRound): RoundDraft => ({
  id: r?.id, name: r?.name ?? "", serviceTypeId: r?.serviceTypeId ?? "", startDate: r?.startDate ?? "", endDate: r?.endDate ?? "", minDays: r?.minDays != null ? String(r.minDays) : "",
  hours: r?.budgetedHours != null ? String(r.budgetedHours) : "", price: r?.unitPriceCents != null ? dollars(r.unitPriceCents) : "", notes: r?.notes ?? "", showNotes: !!r?.notes,
});

function PackageForm({ pkg, onDone }: { pkg: Package | null; onDone: () => void }) {
  const services = useServices(false);
  const all = useServices(true);
  const [name, setName] = useState(pkg?.name ?? "");
  const [description, setDescription] = useState(pkg?.description ?? "");
  const [renewalDate, setRenewalDate] = useState(pkg?.renewalDate ?? "");
  const [active, setActive] = useState(pkg?.active ?? true);
  const [rounds, setRounds] = useState<RoundDraft[]>(pkg?.rounds.length ? pkg.rounds.map(roundDraft) : [roundDraft()]);
  const [moved, setMoved] = useState<number | null>(null);
  const save = useAction();
  const del = useAction();
  const setRound = (i: number, patch: Partial<RoundDraft>) => setRounds((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  /** The ↓ buttons: this row's value for every round below it. */
  const fillDown = (i: number, key: "minDays" | "hours" | "price") => setRounds((rs) => rs.map((r, j) => (j > i ? { ...r, [key]: rs[i][key] } : r)));
  // A round's service that has since been made inactive still shows in its own box.
  const choices = (id: string) => [...services.list, ...all.list.filter((s) => s.id === id && !services.list.some((x) => x.id === id))];
  return (
    <form className="stack todo-form" onSubmit={(e) => {
      e.preventDefault();
      save.run(async () => {
        const body = {
          name, description, renewalDate, active,
          rounds: rounds.filter((r) => r.name.trim() || r.serviceTypeId).map((r) => ({
            id: r.id, name: r.name.trim(), serviceTypeId: r.serviceTypeId, startDate: r.startDate, endDate: r.endDate, minDays: r.minDays.trim() === "" ? null : Number(r.minDays),
            budgetedHours: r.hours.trim() === "" ? null : Number(r.hours), unitPriceCents: r.price.trim() === "" ? null : toCents(r.price), notes: r.notes,
          })),
        };
        if (pkg) {
          const r = await api<{ movedWorkOrders: number }>(`/packages/${pkg.id}`, { method: "PUT", body });
          if (r.movedWorkOrders) { setMoved(r.movedWorkOrders); return; }
        } else await api("/packages", { body });
        onDone();
      });
    }}>
      <div className="formgrid">
        <label>Package name *<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Eco Lawn Service" /></label>
        <label>Description (optional)<input maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Weed control & fertilization, 6 rounds" /></label>
        <label title="When this season ends. Properties on the package are renewed (or called) for the next season from this date.">Renewal date<input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} /></label>
      </div>
      <div className="tablewrap">
        <table className="invoice-lines package-rounds">
          <thead><tr>
            <th style={{ minWidth: 150 }}>Round</th><th style={{ minWidth: 170 }}>Service</th><th>Start</th><th>End</th>
            <th style={{ width: 96 }} title="At least this many days after the property's last service">Min. days</th>
            <th style={{ width: 96 }} title="Budgeted hours on the round's work order (blank: worked out from the lawn's size)">Hours</th>
            <th style={{ width: 150 }} title="Blank: the service's price for each property's lawn">Rate</th><th style={{ width: 80 }} />
          </tr></thead>
          <tbody>{rounds.map((r, i) => {
            const s = all.list.find((x) => x.id === r.serviceTypeId);
            const n = i + 1;
            const down = (key: "minDays" | "hours" | "price", what: string) => i < rounds.length - 1 && r[key].trim() !== "" && (
              <button type="button" className="btn fill-down" title={`Use this ${what} for every round below`} aria-label={`Use round ${n}'s ${what} for every round below`} onClick={() => fillDown(i, key)}>↓</button>
            );
            return (
              <Fragment key={i}>
                <tr>
                  <td><input aria-label={`Round ${n} name`} required={!!r.serviceTypeId} maxLength={120} value={r.name} onChange={(e) => setRound(i, { name: e.target.value })} placeholder="Early Spring" /></td>
                  <td>
                    <select aria-label={`Round ${n} service`} required value={r.serviceTypeId} onChange={(e) => {
                      const svc = all.list.find((x) => x.id === e.target.value);
                      setRound(i, { serviceTypeId: e.target.value, name: r.name.trim() ? r.name : svc?.name ?? "" });
                    }}>
                      <option value="">Pick a service…</option>
                      {choices(r.serviceTypeId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`Round ${n} start`} type="date" required value={r.startDate} onChange={(e) => setRound(i, { startDate: e.target.value })} /></td>
                  <td><input aria-label={`Round ${n} end`} type="date" required min={r.startDate || undefined} value={r.endDate} onChange={(e) => setRound(i, { endDate: e.target.value })} /></td>
                  <td><div className="row nowrap"><input aria-label={`Round ${n} minimum days`} inputMode="numeric" placeholder="0" value={r.minDays} onChange={(e) => setRound(i, { minDays: e.target.value })} />{down("minDays", "minimum days")}</div></td>
                  <td><div className="row nowrap"><input aria-label={`Round ${n} budgeted hours`} inputMode="decimal" placeholder="Auto" value={r.hours} onChange={(e) => setRound(i, { hours: e.target.value })} />{down("hours", "hours")}</div></td>
                  <td>
                    <div className="row nowrap"><input aria-label={`Round ${n} rate`} inputMode="decimal" placeholder="By lawn" value={r.price} onChange={(e) => setRound(i, { price: e.target.value })} />{down("price", "rate")}</div>
                    {s && r.price.trim() === "" && <div className="muted" style={{ fontSize: 12 }}>{describePricing(s)}</div>}
                  </td>
                  <td>
                    <div className="row nowrap">
                      <button type="button" className="btn" title="Notes for the crew, on this round's work orders" aria-label={`Round ${n} notes`} aria-expanded={r.showNotes} onClick={() => setRound(i, { showNotes: !r.showNotes })}><Icon name="messages" size={14} /></button>
                      <button type="button" className="btn" aria-label={`Remove round ${n}`} onClick={() => setRounds((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [roundDraft()]))}>✕</button>
                    </div>
                  </td>
                </tr>
                {r.showNotes && (
                  <tr><td colSpan={8}><input aria-label={`Round ${n} notes for the crew`} maxLength={2000} value={r.notes} onChange={(e) => setRound(i, { notes: e.target.value })} placeholder={`Notes for the crew on ${r.name || "this round"} (goes on its work orders)`} /></td></tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table>
      </div>
      <div>
        {/* A new round starts from the one above: same service, minimum days, hours and rate. */}
        <button type="button" className="btn" onClick={() => setRounds((rs) => { const last = rs[rs.length - 1]; return [...rs, { ...roundDraft(), serviceTypeId: last?.serviceTypeId ?? "", minDays: last?.minDays ?? "", hours: last?.hours ?? "", price: last?.price ?? "" }]; })}><Icon name="plus" size={14} /> Add round</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>A round is on the waiting list from its start date and due by its end date. Leave the rate blank to price it for each property&apos;s lawn from the price list.</p>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (an inactive package can&apos;t be put on more properties; the ones already on it keep running)</label>
      <ErrorBox error={save.error || del.error} />
      {moved != null && <p className="notice" role="status">Saved. {moved} work order{moved === 1 ? "" : "s"} still on the waiting list {moved === 1 ? "was" : "were"} moved to the new dates. <button type="button" className="btn" onClick={onDone}>Done</button></p>}
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : pkg ? "Save package" : "Add package"}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        {pkg && <button type="button" className="btn danger" style={{ marginLeft: "auto" }} disabled={del.busy}
          onClick={() => confirm(`Delete the ${pkg.name} package? This can't be undone.`) && del.run(async () => { await api(`/packages/${pkg.id}`, { method: "DELETE" }); onDone(); })}>Delete</button>}
      </div>
      {pkg && <PropertiesOnPackage packageId={pkg.id} />}
    </form>
  );
}

/** Under the package form: who's on it. */
function PropertiesOnPackage({ packageId }: { packageId: string }) {
  const detail = useApi<{ properties: OnPackage[] }>(`/packages/${packageId}`);
  const [show, setShow] = useState<PropertyPackageStatus>("active");
  const all = detail.data?.properties ?? [];
  const rows = all.filter((x) => x.status === show);
  const count = (s: PropertyPackageStatus) => all.filter((x) => x.status === s).length;
  if (!detail.data) return null;
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Properties on this package</h3>
      <div className="tabs" role="tablist" aria-label="Properties on this package" style={{ margin: "6px 0" }}>
        {(["active", "paused", "cancelled"] as const).map((s) => <button key={s} type="button" role="tab" aria-selected={show === s} onClick={() => setShow(s)}>{PROPERTY_PACKAGE_STATUS_LABELS[s]} ({count(s)})</button>)}
      </div>
      {rows.length ? (
        <div className="tablewrap" style={{ maxHeight: 320, overflowY: "auto" }}>
          <table>
            <thead><tr><th>Customer</th><th>Property</th><th>MC</th><th>Renewal</th><th>Crew</th><th style={{ textAlign: "right" }}>Season</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.id}>
                <td><Link href={`/customers/${x.customer.id}`}>{x.customer.name}</Link></td>
                <td><Link href={`/properties/${x.property.id}`}>{x.property.address}</Link></td>
                <td>{x.property.mapCode ?? <span className="muted">—</span>}</td>
                <td>{PACKAGE_RENEWAL_LABELS[x.renewal] ?? x.renewal}</td>
                <td>{x.crew?.name ?? <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(x.totalCents)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted" style={{ margin: 0 }}>None.</p>}
    </div>
  );
}

// ---- A property's packages ----

type PropertyOption = { id: string; address: string; lawnSqFt?: number | null; frontSqFt?: number | null; backSqFt?: number | null; otherSqFt?: number | null; custom?: Record<string, unknown> | null };
type RoundOnProperty = { roundId: string; name: string; service: string | null; startDate: string | null; endDate: string | null; minDays: number | null; included: boolean; quantity: number; unitPriceCents: number | null; budgetedHours: number | null; amountCents: number; visit: { id: string; number: number; status: string; date: string | null } | null };
type Enrollment = { id: string; propertyId: string; packageId: string | null; packageName: string; renewal: PackageRenewal; status: PropertyPackageStatus; notes: string | null; startedOn: string; crew: { id: string; name: string } | null; property: { id: string; address: string }; rounds: RoundOnProperty[]; totalCents: number };
type Crew = { id: string; name: string; active: boolean };

/** Where a round stands for this property, in a few words. */
function roundStatus(e: Enrollment, r: RoundOnProperty, today: string) {
  if (!r.included) return "Not included";
  if (r.visit) {
    if (r.visit.status === "completed") return "Done";
    if (r.visit.status === "skipped") return "Skipped";
    if (r.visit.status === "on_site") return "On site";
    return r.visit.date ? `Scheduled ${fmtDate(r.visit.date)}` : "On the waiting list";
  }
  if (e.status === "cancelled") return "Cancelled";
  if (roundMissed(r, today)) return "Missed";
  return e.status === "paused" ? "Paused" : "No work order";
}

/** A package's rounds on a property in a few words, for the line that unfolds into them. */
function roundsSummary(e: Enrollment) {
  const inc = e.rounds.filter((r) => r.included);
  const done = inc.filter((r) => r.visit?.status === "completed").length;
  const open = inc.filter((r) => r.visit && (r.visit.status === "open" || r.visit.status === "on_site"));
  const scheduled = open.filter((r) => r.visit!.date).length;
  const waiting = open.length - scheduled;
  return [`${inc.length} round${inc.length === 1 ? "" : "s"}`, done ? `${done} done` : null, scheduled ? `${scheduled} scheduled` : null, waiting ? `${waiting} on the waiting list` : null].filter(Boolean).join(" · ");
}

/**
 * The packages a property is on, as rows inside its Work orders box: no card or heading of its own, and
 * nothing at all for a property that has never had one. Each row's rounds unfold; Edit, Pause and Cancel
 * are on the row. Adding one is Add work order → Package Work Order.
 */
export function PropertyPackageRows({ propertyId, onChanged }: { propertyId: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const manager = can("manager", "customers");
  const list = useApi<{ today: string; items: Enrollment[] }>(manager ? `/packages/enrollments?propertyId=${propertyId}` : null);
  const [showPast, setShowPast] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  if (!manager || !items.length) return null;
  const current = items.filter((e) => e.status !== "cancelled");
  const past = items.filter((e) => e.status === "cancelled");
  const today = list.data?.today ?? "";
  // Pausing or cancelling takes rounds off the waiting list, so the work orders listed below change too.
  const changed = (msg?: string) => { list.reload(); setNote(msg ?? null); onChanged?.(); };
  return (
    <div className="wo-packages" aria-label="Packages on this property">
      <div className="menu-heading" style={{ padding: 0 }}>Packages{current.length ? ` · ${current.length}` : ""}</div>
      {note && <p className="notice" role="status" style={{ margin: "6px 0 0" }}>{note}</p>}
      {current.length > 0 && <ul className="plain-list package-list">{current.map((e) => <EnrollmentRow key={e.id} e={e} today={today} showProperty={false} fold onChanged={changed} />)}</ul>}
      {past.length > 0 && (
        <>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setShowPast(!showPast)}>{showPast ? "Hide" : "Show"} cancelled packages ({past.length})</button>
          {showPast && <ul className="plain-list package-list">{past.map((e) => <EnrollmentRow key={e.id} e={e} today={today} showProperty={false} fold onChanged={changed} />)}</ul>}
        </>
      )}
    </div>
  );
}

/**
 * Add work order → Package Work Order: the property (known from its page, or picked from the customer's),
 * then the package and its rounds. Each round becomes a work order on the waiting list.
 */
export function PackageWorkOrder({ customer: given, propertyId, onCancel, onDone }: {
  customer?: { id: string; name: string } | null; propertyId?: string;
  onCancel: () => void; onDone: (added: { packageName: string; property: { id: string; address: string } }, created: number) => void;
}) {
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(given ?? null);
  // From a property's page: that property, whoever its bill-to is. Otherwise the customer's own properties.
  const one = useApi<any>(propertyId ? `/properties/${propertyId}` : null);
  const detail = useApi<any>(!propertyId && customer ? `/customers/${customer.id}` : null);
  const on = useApi<{ today: string; items: Enrollment[] }>(propertyId ? `/packages/enrollments?propertyId=${propertyId}` : customer ? `/packages/enrollments?customerId=${customer.id}` : null);
  const sizes = (p: any) => ({ lawnSqFt: p.lawnSqFt, frontSqFt: p.frontSqFt, backSqFt: p.backSqFt, otherSqFt: p.otherSqFt, custom: p.custom });
  const properties: PropertyOption[] = propertyId
    ? (one.data ? [{ id: one.data.id, address: formatAddress(one.data), ...sizes(one.data) }] : [])
    // A package's work orders are for the bill-to, so only the properties this customer pays for.
    : (detail.data?.properties ?? []).filter((p: any) => !p.endDate && p.status !== "cancelled" && p.role === "bill_to").map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", "), ...sizes(p) }));
  const loading = propertyId ? !one.data && !one.error : !!customer && !detail.data && !detail.error;
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>New Package Work Order</h2>
      <p className="muted" style={{ margin: 0 }}>A package is a season of rounds. Each round you include becomes a work order on the waiting list, eligible from the round&apos;s start date and due by its end.</p>
      {propertyId ? (
        one.data && <div><span className="todo-label">Property</span><div><strong>{formatAddress(one.data)}</strong></div></div>
      ) : customer ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="todo-label">Customer *</span>
          <div className="row"><strong>{customer.name}</strong><button type="button" className="linkbtn" onClick={() => setCustomer(null)}>Change</button></div>
        </div>
      ) : (
        <>
          <CustomerPicker label="Customer *" onPick={(c) => setCustomer({ id: c.id, name: c.name })} />
          <div className="row"><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
        </>
      )}
      <ErrorBox error={one.error ?? detail.error ?? on.error} />
      {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
      {!loading && (propertyId || customer) && !properties.length && !(one.error ?? detail.error) && (
        <>
          <p className="warn-text" style={{ margin: 0 }}>{customer?.name ?? "This customer"} isn&apos;t the bill-to on an active property, so there&apos;s nowhere to put a package. Add a property on their page first.</p>
          <div className="row"><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
        </>
      )}
      {properties.length > 0 && on.data && (
        <AddPackage key={propertyId ?? customer?.id} properties={properties} taken={on.data.items.filter((e) => e.status !== "cancelled")} today={on.data.today} onClose={onCancel} onDone={onDone} />
      )}
    </div>
  );
}

/**
 * The Packages card on a customer's page (their properties): the packages they're on, round by round,
 * and Add package. A property's own page lists its packages inside the Work orders box instead.
 */
export function PropertyPackages({ properties, customerId, active = true, style }: { properties: PropertyOption[]; customerId?: string; active?: boolean; style?: React.CSSProperties }) {
  const { can } = useAuth();
  const manager = can("manager", "customers");
  const single = !customerId && properties.length === 1 ? properties[0] : null;
  const list = useApi<{ today: string; items: Enrollment[] }>(!manager ? null : customerId ? `/packages/enrollments?customerId=${customerId}` : single ? `/packages/enrollments?propertyId=${single.id}` : null);
  const [adding, setAdding] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!manager) return null;
  const items = list.data?.items ?? [];
  const current = items.filter((e) => e.status !== "cancelled");
  const past = items.filter((e) => e.status === "cancelled");
  const today = list.data?.today ?? "";
  return (
    <div className="card" style={style}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Packages{current.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {current.length}</span> : null}</h2>
        {active && properties.length > 0 && !adding && <button className="btn" onClick={() => { setAdding(true); setNote(null); }}><Icon name="plus" size={14} /> Add package</button>}
      </div>
      {note && <p className="notice" role="status">{note}</p>}
      {adding && (
        <AddPackage properties={properties} taken={current} today={today} onClose={() => setAdding(false)}
          onDone={(e, created) => { setAdding(false); list.reload(); setNote(`${e.packageName} added: ${created} round${created === 1 ? "" : "s"} on the waiting list.`); }} />
      )}
      {current.length ? (
        <ul className="plain-list package-list">
          {current.map((e) => <EnrollmentRow key={e.id} e={e} today={today} showProperty={!single} onChanged={(msg) => { list.reload(); setNote(msg ?? null); }} />)}
        </ul>
      ) : list.data && !adding ? <p className="muted" style={{ margin: "8px 0 0" }}>No packages. A package puts a season of rounds on the waiting list, each in its own window.</p> : null}
      {past.length > 0 && (
        <>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowPast(!showPast)}>{showPast ? "Hide" : "Show"} cancelled ({past.length})</button>
          {showPast && <ul className="plain-list package-list">{past.map((e) => <EnrollmentRow key={e.id} e={e} today={today} showProperty={!single} onChanged={() => list.reload()} />)}</ul>}
        </>
      )}
    </div>
  );
}

function EnrollmentRow({ e, today, showProperty, fold, onChanged }: { e: Enrollment; today: string; showProperty: boolean; /** The rounds stay folded to one line until it's clicked. */ fold?: boolean; onChanged: (msg?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const action = useAction();
  /** Pause or cancel: says what came off the waiting list, and what's left for the office to look at. */
  const stop = (what: "pause" | "cancel") => action.run(async () => {
    const r = await api<{ removed: number; stillScheduled: number }>(`/packages/enrollments/${e.id}/${what}`, { method: "POST" });
    onChanged(`${e.packageName} ${what === "pause" ? "paused" : "cancelled"}: ${r.removed} round${r.removed === 1 ? "" : "s"} taken off the waiting list.${r.stillScheduled ? ` ${r.stillScheduled} work order${r.stillScheduled === 1 ? " already has" : "s already have"} a date and ${r.stillScheduled === 1 ? "was" : "were"} left alone: open ${r.stillScheduled === 1 ? "it" : "them"} below to decide.` : ""}`);
  });
  const rounds = (
    <ul className="package-lines">
      {e.rounds.map((r) => (
        <li key={r.roundId} className={r.included ? "" : "muted"}>
          <strong style={{ fontWeight: 600 }}>{r.name}</strong>
          <span className="muted"> · {fmtDate(r.startDate)} – {fmtDate(r.endDate)}{r.included && r.amountCents ? ` · ${formatMoney(r.amountCents)}` : ""} · </span>
          {r.visit ? <Link href={`/visits/${r.visit.id}`}>{visitNumber(r.visit.number)} {roundStatus(e, r, today)}</Link> : <span className="muted">{roundStatus(e, r, today)}</span>}
        </li>
      ))}
    </ul>
  );
  return (
    <li style={{ opacity: e.status === "cancelled" ? 0.7 : 1 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{e.packageName}</strong> <span className={`badge ${STATUS_TONE[e.status]}`}>{PROPERTY_PACKAGE_STATUS_LABELS[e.status]}</span>
          <div className="muted" style={{ fontSize: 13 }}>
            {[showProperty ? e.property.address : null, PACKAGE_RENEWAL_LABELS[e.renewal] ?? e.renewal, e.crew ? e.crew.name : "No crew", `${formatMoney(e.totalCents)} this season`, `since ${fmtDate(e.startedOn)}`].filter(Boolean).join(" · ")}
          </div>
          {e.notes && <div style={{ fontSize: 13 }}>{e.notes}</div>}
        </div>
        {e.status !== "cancelled" && (
          <span className="row">
            <button className="btn" onClick={() => setEditing(!editing)}>Edit</button>
            {e.status === "active"
              ? <button className="btn" disabled={action.busy} title="Takes its rounds off the waiting list until you resume it" onClick={() => confirm(`Pause ${e.packageName}? Its rounds come off the waiting list until you resume it.`) && stop("pause")}>Pause</button>
              : <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { const r = await api<{ created: number }>(`/packages/enrollments/${e.id}/resume`, { method: "POST" }); onChanged(`${e.packageName} resumed: ${r.created} round${r.created === 1 ? "" : "s"} back on the waiting list.`); })}>Resume</button>}
            <button className="btn danger" disabled={action.busy} onClick={() => confirm(`Cancel ${e.packageName} here? Its rounds come off the waiting list. This can't be undone (the package can be added again).`) && stop("cancel")}>Cancel</button>
          </span>
        )}
      </div>
      <ErrorBox error={action.error} />
      {editing && <EditEnrollment e={e} onDone={(saved) => { setEditing(false); if (saved) onChanged(); }} />}
      {fold ? <details className="package-fold"><summary>{roundsSummary(e)}</summary>{rounds}</details> : rounds}
    </li>
  );
}

function CrewSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const crews = useApi<Crew[]>("/crews?all=1");
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No crew yet</option>
      {(crews.data ?? []).filter((c) => c.active || c.id === value).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function EditEnrollment({ e, onDone }: { e: Enrollment; onDone: (saved: boolean) => void }) {
  const [renewal, setRenewal] = useState<PackageRenewal>(e.renewal);
  const [crewId, setCrewId] = useState(e.crew?.id ?? "");
  const [notes, setNotes] = useState(e.notes ?? "");
  const save = useAction();
  return (
    <form className="stack todo-form" style={{ margin: "8px 0" }} onSubmit={(ev) => { ev.preventDefault(); save.run(async () => { await api(`/packages/enrollments/${e.id}`, { method: "PUT", body: { renewal, crewId, notes } }); onDone(true); }); }}>
      <div className="formgrid">
        <label>When the season ends<select value={renewal} onChange={(ev) => setRenewal(ev.target.value as PackageRenewal)}>{PACKAGE_RENEWALS.map((r) => <option key={r} value={r}>{PACKAGE_RENEWAL_LABELS[r]}</option>)}</select></label>
        <label title="Also goes on this package's work orders still on the waiting list">Crew<CrewSelect value={crewId} onChange={setCrewId} /></label>
        <label>Notes (optional)<input maxLength={2000} value={notes} onChange={(ev) => setNotes(ev.target.value)} /></label>
      </div>
      <ErrorBox error={save.error} />
      <div className="row"><button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : "Save"}</button><button type="button" className="btn" onClick={() => onDone(false)}>Cancel</button></div>
    </form>
  );
}

type Pick = { include: boolean; quantity: string; price: string; hours: string; scheduleMissed: boolean };

function AddPackage({ properties, taken, today, onClose, onDone }: { properties: PropertyOption[]; taken: Enrollment[]; today: string; onClose: () => void; onDone: (e: Enrollment, created: number) => void }) {
  const pkgs = useApi<Package[]>("/packages");
  const services = useServices(true);
  const [propertyId, setPropertyId] = useState(properties.length === 1 ? properties[0].id : "");
  const [packageId, setPackageId] = useState("");
  const [renewal, setRenewal] = useState<PackageRenewal>("auto");
  const [crewId, setCrewId] = useState("");
  const [notes, setNotes] = useState("");
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const save = useAction();
  const property = properties.find((p) => p.id === propertyId) ?? null;
  const pkg = pkgs.data?.find((p) => p.id === packageId) ?? null;
  // The price list's price for this lawn, round by round (the package's own rate wins).
  const listed = useMemo(() => (pkg && property ? packageToLines(pkg.rounds.map((r) => ({ serviceTypeId: r.serviceTypeId, description: r.name, quantity: 1, unitPriceCents: r.unitPriceCents })), services.list as never, property as never) : []), [pkg, property, services.list]);
  // A new package or property: every round ticked and priced, except ones whose window is already over.
  useEffect(() => {
    if (!pkg) return setPicks({});
    setPicks(Object.fromEntries(pkg.rounds.map((r, i) => [r.id!, {
      include: true, quantity: "1", price: listed[i]?.unitPriceCents != null ? dollars(listed[i].unitPriceCents!) : "", hours: r.budgetedHours != null ? String(r.budgetedHours) : "", scheduleMissed: false,
    }])));
  }, [packageId, propertyId, listed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const setPick = (id: string, patch: Partial<Pick>) => setPicks((ps) => ({ ...ps, [id]: { ...ps[id], ...patch } }));
  const offered = (pkgs.data ?? []).filter((p) => !taken.some((e) => e.packageId === p.id && e.propertyId === propertyId));
  const making = (r: PackageRound) => { const p = picks[r.id!]; return !!p?.include && (!roundMissed(r, today) || p.scheduleMissed); };
  const total = pkg ? pkg.rounds.reduce((s, r) => { const p = picks[r.id!]; const cents = p ? toCents(p.price || "0") : 0; return s + (making(r) && Number.isFinite(cents) ? lineAmount({ quantity: Number(p.quantity) || 0, unitPriceCents: cents }) : 0); }, 0) : 0;
  const count = pkg ? pkg.rounds.filter(making).length : 0;
  const noSize = !!property && !property.lawnSqFt;
  return (
    <form className="stack todo-form" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!pkg) return;
      save.run(async () => {
        const rounds = pkg.rounds.map((r) => {
          const p = picks[r.id!];
          const cents = p.price.trim() === "" ? null : toCents(p.price);
          if (p.include && cents != null && !Number.isFinite(cents)) throw new Error(`Check the rate for ${r.name}`);
          return { roundId: r.id, include: p.include, quantity: Number(p.quantity) || 1, unitPriceCents: cents, budgetedHours: p.hours.trim() === "" ? null : Number(p.hours), scheduleMissed: p.scheduleMissed };
        });
        const made = await api<Enrollment & { created: number }>("/packages/enrollments", { body: { propertyId, packageId, renewal, crewId, notes, rounds } });
        onDone(made, made.created);
      });
    }}>
      <div className="formgrid">
        {properties.length > 1 && (
          <label>Property *<select required value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setPackageId(""); }}>
            <option value="">Pick a property…</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
          </select></label>
        )}
        <label>Package *<select required value={packageId} disabled={!propertyId} onChange={(e) => setPackageId(e.target.value)}>
          <option value="">{pkgs.data && !offered.length ? "No packages to add" : "Pick a package…"}</option>
          {offered.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label title="What happens when the season ends">When the season ends<select value={renewal} onChange={(e) => setRenewal(e.target.value as PackageRenewal)}>{PACKAGE_RENEWALS.map((r) => <option key={r} value={r}>{PACKAGE_RENEWAL_LABELS[r]}</option>)}</select></label>
        <label title="The crew or truck its rounds go to">Crew<CrewSelect value={crewId} onChange={setCrewId} /></label>
        <label>Notes (optional)<input maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Sold by phone, prepaying in March…" /></label>
      </div>
      {pkgs.data && !pkgs.data.length && <p className="muted" style={{ margin: 0 }}>No packages yet. An admin adds them under <Link href="/price-list#packages">Products &amp; services</Link>.</p>}
      {pkg && noSize && <p className="warn-text" style={{ margin: 0 }}>This property has no lawn size yet, so rounds priced from the lawn have no rate. Type the rates, or measure the lawn first.</p>}
      {pkg && (
        <div className="tablewrap">
          <table className="invoice-lines package-rounds">
            <thead><tr><th style={{ width: 44 }} title="Untick a round this property doesn't get">Inc.</th><th>Round</th><th>Window</th><th style={{ width: 70 }}>Min. days</th><th style={{ width: 70 }}>Qty</th><th style={{ width: 130 }}>Rate</th><th style={{ width: 80 }}>Hours</th><th style={{ width: 90, textAlign: "right" }}>Amount</th></tr></thead>
            <tbody>{pkg.rounds.map((r, i) => {
              const p = picks[r.id!];
              if (!p) return null;
              const missed = roundMissed(r, today);
              const on = making(r);
              const cents = toCents(p.price || "0");
              const list = listed[i]?.unitPriceCents ?? null;
              const service = services.list.find((s) => s.id === r.serviceTypeId);
              return (
                <tr key={r.id} style={{ opacity: on ? 1 : 0.6 }}>
                  <td><input type="checkbox" aria-label={`Include ${r.name}`} checked={p.include} onChange={(e) => setPick(r.id!, { include: e.target.checked })} /></td>
                  <td><strong>{r.name}</strong>{service && service.name !== r.name && <div className="muted" style={{ fontSize: 12 }}>{service.name}</div>}{r.notes && <div className="muted" style={{ fontSize: 12 }}>{r.notes}</div>}</td>
                  <td>
                    {fmtDate(r.startDate)} – {fmtDate(r.endDate)}
                    {missed && p.include && (
                      <div className="missed-round" title="Its window is over. Tick to put it on the waiting list anyway, due now.">
                        <span className="badge warn">Missed</span>
                        <label><input type="checkbox" checked={p.scheduleMissed} onChange={(e) => setPick(r.id!, { scheduleMissed: e.target.checked })} /> Schedule anyway</label>
                      </div>
                    )}
                  </td>
                  <td>{r.minDays ?? <span className="muted">—</span>}</td>
                  <td><input aria-label={`${r.name} quantity`} inputMode="decimal" disabled={!p.include} value={p.quantity} onChange={(e) => setPick(r.id!, { quantity: e.target.value })} /></td>
                  <td>
                    <div className="row nowrap">
                      <input aria-label={`${r.name} rate`} inputMode="decimal" required={p.include} disabled={!p.include} placeholder="0.00" value={p.price} onChange={(e) => setPick(r.id!, { price: e.target.value })} />
                      {i < pkg.rounds.length - 1 && p.price.trim() !== "" && <button type="button" className="btn fill-down" title="Use this rate for every round below" aria-label={`Use ${r.name}'s rate for every round below`} onClick={() => setPicks((ps) => Object.fromEntries(pkg.rounds.map((x, j) => [x.id!, j > i ? { ...ps[x.id!], price: p.price } : ps[x.id!]])))}>↓</button>}
                    </div>
                    {/* Where the rate came from, and a way back to it after a change (like Service Autopilot's rate lookup). */}
                    {list != null && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.unitPriceCents != null ? "Package rate" : "Price list"} {formatMoney(list)}
                        {p.include && cents !== list && <> · <button type="button" className="linklike" onClick={() => setPick(r.id!, { price: dollars(list) })}>use</button></>}
                      </div>
                    )}
                  </td>
                  <td><input aria-label={`${r.name} budgeted hours`} inputMode="decimal" disabled={!p.include} placeholder="Auto" value={p.hours} onChange={(e) => setPick(r.id!, { hours: e.target.value })} /></td>
                  <td style={{ textAlign: "right" }}>{on && Number.isFinite(cents) ? formatMoney(lineAmount({ quantity: Number(p.quantity) || 0, unitPriceCents: cents })) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}</tbody>
            <tfoot><tr><td colSpan={6} className="muted">{count} round{count === 1 ? "" : "s"} will go on the waiting list, each eligible from its start date and due by its end.</td><td style={{ textAlign: "right" }}><strong>Season</strong></td><td style={{ textAlign: "right" }}><strong>{formatMoney(total)}</strong></td></tr></tfoot>
          </table>
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy || !pkg || !count}>{save.busy ? "Adding…" : "Add package"}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
