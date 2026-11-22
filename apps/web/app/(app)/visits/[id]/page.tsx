"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { VISIT_BILLING_LABELS, formatMoney, visitNumber } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { CrewButtons, VisitForm, VisitStatus, crewNames, trackedLabel, visitWhen, type Visit } from "@/components/visits";

type Detail = Visit & { seriesLeft: number; today: string; canManage: boolean; isCrew: boolean };

export default function WorkOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const data = useApi<Detail>(`/visits/${id}`);
  const [editing, setEditing] = useState(false);
  const act = useAction();
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
        sub={<><VisitStatus v={v} /> · {visitWhen(v)}{v.seriesId ? ` · ${v.repeatLabel ?? "repeats"}` : ""}</>}>
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
              {v.property?.lawnSqFt && <><dt>Lawn</dt><dd>{Math.round(v.property.lawnSqFt).toLocaleString()} sq ft</dd></>}
              {v.location && <><dt>Location</dt><dd>{v.location}</dd></>}
              <dt>When</dt><dd>{visitWhen(v)}</dd>
              <dt>Crew</dt><dd>{crewNames(v) || "No crew yet"}</dd>
              {v.budgetedHours != null && <><dt>Budgeted</dt><dd>{v.budgetedHours} hour{v.budgetedHours === 1 ? "" : "s"}</dd></>}
              {v.notes && <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{v.notes}</dd></>}
            </dl>
            {(v.canManage || v.isCrew) && <CrewButtons v={v} onChange={update} />}
          </div>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Work and billing</h2>
            <table className="pt-lines">
              <tbody>{v.lines.map((l) => (
                <tr key={l.id}><td>{l.description}{l.quantity !== 1 ? ` × ${l.quantity}` : ""}{l.budgetedHours ? <span className="muted"> · {l.budgetedHours} h</span> : null}</td>
                  {v.canManage && <td className="num">{formatMoney(l.amountCents)}</td>}</tr>
              ))}</tbody>
              {v.canManage && <tfoot><tr className="total"><td>Total</td><td className="num">{formatMoney(v.totalCents)}</td></tr></tfoot>}
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
    </>
  );
}
