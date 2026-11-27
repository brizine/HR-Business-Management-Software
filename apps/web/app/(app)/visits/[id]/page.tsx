"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { CONTACT_PHONES, FORM_OF_CONTACT_LABELS, PRIORITY_LABELS, VISIT_BILLING_LABELS, type FormOfContact, formatMoney, formatPhone, formatRateAmount, formatTaxRate, taxFor, visitNumber } from "@crewdesk/shared";
import { api, fmtDate, fmtDateTime } from "@/lib/api";
import { BackToWaitlist, windowText } from "@/components/waitlist";
import { WorkOrderWeather } from "@/components/weather";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { CrewButtons, VisitForm, VisitStatus, VisitTags, crewNames, trackedLabel, visitWhen, type Visit } from "@/components/visits";
import { VisitFiles } from "@/components/visit-files";
import { areaSummary, useSizes } from "@/components/line-area";
import { WorkOrderForms } from "@/components/visit-forms";
import { useAuth } from "@/lib/auth";
import { CustomFacts, CustomFieldsCard } from "@/components/custom-fields";

type Detail = Visit & { seriesLeft: number; today: string; canManage: boolean; isCrew: boolean };

export default function WorkOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // The names of the property's size fields, for a line priced from one of them.
  const sizes = useSizes();
  const router = useRouter();
  const data = useApi<Detail>(`/visits/${id}`);
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const { me } = useAuth();
  const v = data.data;
  if (data.error) return <><PageHead title="Work order" /><ErrorBox error={data.error} /></>;
  if (!v) return <PageHead title="Work order" sub="Loading…" />;
  const update = (next: Visit) => data.setData({ ...v, ...next });
  const mapUrl = v.property ? (v.property.lat != null ? `https://www.google.com/maps/search/?api=1&query=${v.property.lat},${v.property.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.property.address)}`) : null;
  const remove = (scope: "one" | "following") => act.run(async () => { await api(`/visits/${v.id}?scope=${scope}`, { method: "DELETE" }); router.push("/visits"); });
  const canInvoice = v.canManage && v.billing === "invoice" && !v.invoiced && v.status !== "skipped" && v.lines.length > 0;

  return (
    <>
      <PageHead title={`${visitNumber(v.number)} ${v.title}`} before={<Link className="btn" href="/visits" aria-label="Back to work orders">←</Link>}
        sub={<><VisitStatus v={v} /> · {visitWhen(v)}{v.seriesId ? ` · ${v.repeatLabel ?? "repeats"}` : ""}{v.tags?.length ? <> · <VisitTags v={v} /></> : null}</>}>
        {mapUrl && <a className="btn" href={mapUrl} target="_blank" rel="noopener noreferrer">Directions</a>}
        {v.canManage && !editing && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {canInvoice && (
          <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => { const r = await api<{ invoiceId: string }>(`/visits/${v.id}/invoice`, { method: "POST" }); router.push(`/invoices/${r.invoiceId}`); })}>Create invoice</button>
        )}
      </PageHead>
      <ErrorBox error={act.error} />
      {editing ? (
        <VisitForm visit={v} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); data.reload(); }} />
      ) : (
        <div className="grid cols-2">
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Where and who</h2>
            <dl className="facts">
              <dt>Customer</dt><dd>{v.canManage ? <Link href={`/customers/${v.customer.id}`}>{v.customer.name}</Link> : v.customer.name}{v.customer.phone ? ` · ${v.customer.phone}` : ""}</dd>
              {v.property && <><dt>Property</dt><dd>{v.canManage ? <Link href={`/properties/${v.property.id}`}>{v.property.address}</Link> : v.property.address}{v.property.name ? ` (${v.property.name})` : ""}</dd></>}
              {v.property?.gateCode && <><dt>Gate code</dt><dd>{v.property.gateCode}</dd></>}
              {v.property?.pets && <><dt>Pets</dt><dd>{v.property.pets}</dd></>}
              {v.property?.accessNotes && <><dt>Access</dt><dd>{v.property.accessNotes}</dd></>}
              {(v.property?.contacts ?? []).map((k, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <dt>{k.relation}</dt>
                  <dd>
                    {k.name}{k.nickname && k.nickname !== k.name && <span className="muted"> “{k.nickname}”</span>}
                    {CONTACT_PHONES.filter(([key]) => k[key]).map(([key, label]) => <span key={key}> · {label} <a href={`tel:${k[key]}`}>{formatPhone(k[key]!)}</a></span>)}
                    {k.email && <> · <a href={`mailto:${k.email}`}>{k.email}</a></>}
                    {k.formOfContact && <span className="muted"> · prefers {FORM_OF_CONTACT_LABELS[k.formOfContact as FormOfContact]?.toLowerCase()}</span>}
                    {k.notes && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{k.notes}</div>}
                  </dd>
                </div>
              ))}
              {v.property?.lawnSqFt && <><dt>Lawn</dt><dd>{Math.round(v.property.lawnSqFt).toLocaleString()} sq ft</dd></>}
              <CustomFacts target="property" values={v.property?.custom} />
              {v.location && <><dt>Location</dt><dd>{v.location}</dd></>}
              <dt>When</dt><dd>{visitWhen(v)}</dd>
              <dt>Crew</dt><dd>{v.crew && <span className="visit-dot" style={{ background: v.crew.color }} />}{crewNames(v) || "No crew yet"}</dd>
              {v.budgetedHours != null && <><dt>Budgeted</dt><dd>{v.budgetedHours} hour{v.budgetedHours === 1 ? "" : "s"}</dd></>}
              {v.releaseOn && <><dt>Eligible from</dt><dd>{fmtDate(v.releaseOn)}</dd></>}
              {v.dueBy && <><dt>Due by</dt><dd>{fmtDate(v.dueBy)}</dd></>}
              {v.minDaysAfterLast && <><dt>Minimum gap</dt><dd>{v.minDaysAfterLast} days after the last service</dd></>}
              {v.priority && v.priority !== "normal" && <><dt>Priority</dt><dd>{PRIORITY_LABELS[v.priority]}</dd></>}
              {v.windowStart && <><dt>Appointment</dt><dd>{windowText(v.windowStart, v.windowEnd ?? null)}</dd></>}
              {v.earlyReason && <><dt>Scheduled early</dt><dd>{v.earlyReason}</dd></>}
              {v.backReason && !v.date && <><dt>Back on the waiting list</dt><dd>{v.backReason}</dd></>}
              {v.notes && <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{v.notes}</dd></>}
            </dl>
            {(v.canManage || v.isCrew) && <CrewButtons v={v} onChange={update} />}
            {v.canManage && v.date && (v.status === "open" || v.status === "on_site") && <BackToWaitlist visitId={v.id} onDone={data.reload} />}
            {v.canManage && !v.date && v.status === "open" && <p className="muted" style={{ margin: 0 }}>No date yet: it&apos;s on the <Link href="/waitlist">waiting list</Link>.</p>}
          </div>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Work and billing</h2>
            <table className="pt-lines">
              <tbody>{v.lines.map((l) => (
                <tr key={l.id}><td>{l.description}{areaSummary(l, v.property, sizes.names) ? <span className="muted"> · {areaSummary(l, v.property, sizes.names)}</span> : null}{l.quantity !== 1 ? ` × ${l.quantity}` : ""}{l.budgetedHours ? <span className="muted"> · {l.budgetedHours} h</span> : null}{v.canManage && l.taxRate ? <span className="muted"> · taxed {formatTaxRate(l.taxRate)}</span> : null}</td>
                  {v.canManage && <td className="num">{formatMoney(l.amountCents)}</td>}</tr>
              ))}</tbody>
              {v.canManage && (() => {
                const tax = taxFor(v.lines.map((l) => ({ quantity: l.quantity, unitPriceCents: l.unitPriceCents ?? 0, taxRate: l.taxRate ?? 0 })));
                return (
                  <tfoot>
                    {tax > 0 && <tr><td>Sales tax</td><td className="num">{formatMoney(tax)}</td></tr>}
                    <tr className="total"><td>Total</td><td className="num">{formatMoney((v.totalCents ?? 0) + tax)}</td></tr>
                  </tfoot>
                );
              })()}
            </table>
            {!v.lines.length && <p className="muted" style={{ margin: 0 }}>No line items.</p>}
            <dl className="facts">
              <dt>Billing</dt><dd>{VISIT_BILLING_LABELS[v.billing]}</dd>
              {v.invoice && <><dt>Invoice</dt><dd><Link href={`/invoices/${v.invoice.id}`}>{v.invoice.number ? `Invoice ${v.invoice.number}` : "Draft invoice"}</Link> · {v.invoice.status}</dd></>}
              {v.startedAt && <><dt>Arrived</dt><dd>{fmtDateTime(v.startedAt)}</dd></>}
              {v.completedAt && <><dt>Completed</dt><dd>{fmtDateTime(v.completedAt)}{v.finishedBy ? ` by ${v.finishedBy}` : ""}{v.trackedMinutes != null ? ` · ${trackedLabel(v.trackedMinutes)} on site` : ""}</dd></>}
              {v.skippedAt && <><dt>Skipped</dt><dd>{fmtDateTime(v.skippedAt)}{v.finishedBy ? ` by ${v.finishedBy}` : ""}: {v.skipReason}</dd></>}
              {v.completionNotes && <><dt>Crew notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{v.completionNotes}</dd></>}
              {v.createdBy && <><dt>Made by</dt><dd>{v.createdBy}</dd></>}
            </dl>
            {v.canManage && !v.invoiced && (
              <div className="row">
                {v.seriesId ? (
                  <>
                    <button className="btn danger" disabled={act.busy} onClick={() => confirm("Delete just this work order?") && remove("one")}>Delete this one</button>
                    <button className="btn danger" disabled={act.busy} onClick={() => confirm(`Delete this one and the later open ones (${v.seriesLeft})?`) && remove("following")}>Delete this and later</button>
                  </>
                ) : <button className="btn danger" disabled={act.busy} onClick={() => confirm("Delete this work order?") && remove("one")}>Delete</button>}
              </div>
            )}
          </div>
        </div>
      )}
      {!editing && !!v.forms?.length && <div style={{ marginTop: 16 }}><WorkOrderForms visitId={v.id} forms={v.forms} onChanged={data.reload} /></div>}
      {!editing && me?.access?.chemicalTracking && v.status === "completed" && <div style={{ marginTop: 16 }}><WorkOrderWeather visitId={v.id} /></div>}
      {!editing && v.status === "completed" && <VisitProducts visitId={v.id} completedAt={v.completedAt} />}
      {!editing && me?.access?.chemicalTracking && v.status === "completed" && <ChemicalRecordLink visitId={v.id} completedAt={v.completedAt} />}
      {!editing && <div style={{ marginTop: 16 }}><CustomFieldsCard target="workorder" id={v.id} canEdit={v.canManage || v.isCrew} values={v.custom ?? {}} onSaved={(custom) => update({ ...v, custom })} /></div>}
      {!editing && <div style={{ marginTop: 16 }}><VisitFiles visitId={v.id} canAdd={v.canManage || v.isCrew} canManage={v.canManage} meId={me?.user.id} /></div>}
    </>
  );
}

interface AppliedProduct { id: string; productName: string; epaRegNo: string | null; rateName: string | null; amountPer1000: number; areaSqFt: number; amount: number; unit: string; costCents?: number | null; costDate: string }

/** What the work order applied, saved when it was completed, with its cost on that day (office only). */
function VisitProducts({ visitId, completedAt }: { visitId: string; completedAt: string | null }) {
  const rows = useApi<AppliedProduct[]>(`/visits/${visitId}/products?c=${completedAt ?? ""}`);
  const list = rows.data ?? [];
  if (!list.length) return null;
  const showCost = list.some((r) => "costCents" in r);
  const total = list.reduce((s, r) => s + (r.costCents ?? 0), 0);
  return (
    <div className="card tablewrap" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Products applied</h3>
      <table>
        <thead><tr><th>Product</th><th>Rate</th><th>Area</th><th>Amount</th>{showCost && <th>Cost</th>}</tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.id}>
            <td>{r.productName}{r.epaRegNo && <div className="muted">EPA {r.epaRegNo}</div>}</td>
            <td>{r.rateName ? `${r.rateName}: ` : ""}{formatRateAmount(r.amountPer1000, r.unit)} / 1,000</td>
            <td>{Math.round(r.areaSqFt).toLocaleString("en-US")} sq ft</td>
            <td>{formatRateAmount(r.amount, r.unit)}</td>
            {showCost && <td>{r.costCents == null ? <span className="muted">no cost on {r.costDate}</span> : formatMoney(r.costCents)}</td>}
          </tr>
        ))}</tbody>
        {showCost && <tfoot><tr><td colSpan={4}><strong>Material</strong> <span className="muted">(prices on {list[0].costDate})</span></td><td><strong>{formatMoney(total)}</strong></td></tr></tfoot>}
      </table>
    </div>
  );
}

/** The work order's chemical application record (ODAFF), when it has one. */
function ChemicalRecordLink({ visitId, completedAt }: { visitId: string; completedAt: string | null }) {
  const recs = useApi<{ id: string; issues: string[] }[]>(`/chemical-records?visitId=${visitId}&c=${completedAt ?? ""}`);
  const r = recs.data?.[0];
  if (!r) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>Chemical application record</strong>{" "}
      {r.issues.length ? <span className="badge warn">{r.issues.length} missing</span> : <span className="badge ok">complete</span>}{" "}
      <Link href={`/chemical-tracking/records/${r.id}`}>Open record</Link>
    </div>
  );
}
