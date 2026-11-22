"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { PROPERTY_ROLE_LABELS, formatAddress, formatPhone, type PropertyRole } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";
import { CancelForm, CustomerPicker, PropertyFields, TagChips, propertyBody, propertyFormValue, useTags } from "@/components/customers";
import { CreditForm } from "@/components/credits";

export default function PropertyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const router = useRouter();
  const { tags } = useTags();
  const property = useApi<any>(`/properties/${id}`);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [creditNote, setCreditNote] = useState<string | null>(null);
  const action = useAction();
  const p = property.data;
  if (property.error) return <><PageHead title="Property" /><ErrorBox error={property.error} /></>;
  if (!p) return <PageHead title="Property" sub="Loading…" />;
  const current = p.assignments.filter((a: any) => !a.endDate);
  const past = p.assignments.filter((a: any) => a.endDate);
  const billTo = current.find((a: any) => a.role === "bill_to");
  const lawn = p.lawnSqFt ? `${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : "—";
  const mapsLink = p.lat != null && p.lng != null ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(p))}`;

  return (
    <>
      <PageHead title={p.street} crumbs={billTo
        ? [{ label: "Customers", href: "/customers" }, { label: billTo.name, href: `/customers/${billTo.customerId}` }, { label: p.street }]
        : [{ label: "Properties", href: "/properties" }, { label: p.street }]}
        sub={<>{[p.name, [p.city, p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ")} · <Badge value={p.status} />{p.sample && <> · <span className="tag tag-gray">Sample</span></>}</>}>
        <a className="btn" href={mapsLink} target="_blank" rel="noopener noreferrer">Map</a>
        {billTo && can("manager", "customers") && <button className="btn" onClick={() => setCrediting(!crediting)}>Add credit</button>}
        {p.status !== "cancelled" && <button className="btn" onClick={() => setEditing(!editing)}>Edit</button>}
        {p.status !== "cancelled"
          ? <button className="btn danger" onClick={() => setCancelling(!cancelling)}>Cancel property</button>
          : <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { await api(`/properties/${id}/reactivate`, { method: "POST" }); property.reload(); })}>Reactivate</button>}
        {can("admin", "customers") && (p.sample || p.assignments.length === 0) && (
          <button className="btn danger" disabled={action.busy} onClick={() => confirm("Delete this property? This can't be undone.") && action.run(async () => { await api(`/properties/${id}`, { method: "DELETE" }); router.push("/properties"); })}>Delete</button>
        )}
      </PageHead>
      <ErrorBox error={action.error} />
      {cancelling && <CancelForm what="property" onClose={() => setCancelling(false)} onSubmit={async (body) => { await api(`/properties/${id}/cancel`, { body }); property.reload(); }} />}
      {crediting && billTo && (
        <>
          <p className="muted" style={{ margin: "0 0 6px" }}>Credit for <strong>{billTo.name}</strong> (the bill-to), for this property&apos;s invoices.</p>
          <CreditForm customerId={billTo.customerId} properties={[{ id, address: formatAddress(p) }]} propertyId={id}
            onDone={() => { setCrediting(false); setCreditNote(`Credit added for ${billTo.name}. It's on their page under Credits.`); }} onClose={() => setCrediting(false)} />
        </>
      )}
      {creditNote && <p className="notice" role="status">{creditNote} <Link href={`/customers/${billTo?.customerId}`}>Open {billTo?.name}</Link></p>}
      {editing ? <EditProperty property={p} tags={tags} onDone={() => { setEditing(false); property.reload(); }} /> : (
        <div className="grid cols-2">
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Property</h2>
            <dl className="facts">
              <dt>Map Code</dt><dd>{p.mapCode ?? <span className="muted">No MC</span>}{p.mapCode && p.mapCodeManual && <span className="muted"> (set by hand)</span>}</dd>
              <dt>Lawn</dt><dd>{lawn}{(p.frontSqFt != null || p.backSqFt != null) && <span className="muted"> · front {Math.round(p.frontSqFt ?? 0).toLocaleString()}, back {Math.round(p.backSqFt ?? 0).toLocaleString()}</span>}</dd>
              <dt>Measured</dt><dd>{p.measurement ? <>{p.measurement.name} <span className="muted">· {fmtDate(p.measurement.updatedAt)}</span></> : <span className="muted">Not linked to a saved Property Measure</span>}</dd>
              <dt>Gate code</dt><dd>{p.gateCode ?? "—"}</dd>
              <dt>Pets</dt><dd>{p.pets ?? "—"}</dd>
              <dt>Tags</dt><dd><TagChips ids={p.tagIds} tags={tags} /> {!p.tagIds.length && "—"}</dd>
            </dl>
            {p.accessNotes && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Access notes</h3><p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{p.accessNotes}</p></>}
            {p.notes && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Notes</h3><p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{p.notes}</p></>}
          </div>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ fontSize: 16, margin: 0 }}>People</h2>
              {p.status !== "cancelled" && <button className="btn" onClick={() => setAssigning(!assigning)}>Add a person</button>}
            </div>
            {!billTo && <p className="warn-text">No bill-to yet: nobody gets invoices for this property.</p>}
            {assigning && <AssignPerson propertyId={id} hasBillTo={!!billTo} exclude={current.map((a: any) => a.customerId)} onDone={() => { setAssigning(false); property.reload(); }} />}
            <ul className="plain-list" style={{ marginTop: 12 }}>
              {current.map((a: any) => (
                <li key={a.assignmentId}>
                  <span className={`badge ${a.role === "bill_to" ? "ok" : ""}`}>{PROPERTY_ROLE_LABELS[a.role as PropertyRole]}</span>{" "}
                  <Link href={`/customers/${a.customerId}`}><strong>{a.name}</strong></Link> <span className="muted">since {fmtDate(a.startDate)}</span>
                  <div className="muted">{[a.email, a.phone && formatPhone(a.phone)].filter(Boolean).join(" · ")}</div>
                  {a.role === "resident" && (
                    <button className="btn" style={{ marginTop: 4 }} disabled={action.busy} onClick={() => confirm(`${a.name} no longer lives here?`) && action.run(async () => {
                      await api(`/properties/${id}/assignments/${a.assignmentId}/end`, { body: {} }); property.reload();
                    })}>Moved out</button>
                  )}
                </li>
              ))}
            </ul>
            {past.length > 0 && (
              <>
                <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowPast(!showPast)}>{showPast ? "Hide" : "Show"} history ({past.length})</button>
                {showPast && (
                  <ul className="plain-list" style={{ marginTop: 8 }}>
                    {past.map((a: any) => (
                      <li key={a.assignmentId} className="muted">
                        {PROPERTY_ROLE_LABELS[a.role as PropertyRole]}: <Link href={`/customers/${a.customerId}`}>{a.name}</Link> · {fmtDate(a.startDate)} – {fmtDate(a.endDate)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {p.cancellations.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Cancellations</h2>
          <ul className="plain-list">
            {p.cancellations.map((x: any) => (
              <li key={x.id}>
                <strong>{x.reasonLabel}</strong> <span className="muted">effective {fmtDate(x.effectiveDate)}{x.reactivatedAt ? ` · reactivated ${fmtDate(x.reactivatedAt)}` : ""}</span>
                {x.comment && <div>{x.comment}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function EditProperty({ property, tags, onDone }: { property: any; tags: any[]; onDone: () => void }) {
  const [value, setValue] = useState(propertyFormValue(property));
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/properties/${property.id}`, { method: "PUT", body: propertyBody(value) }); onDone(); }); }}>
      <PropertyFields value={value} onChange={setValue} tags={tags} />
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** Puts a customer on the property: as the new bill-to (the old one's time ends) or as a resident. */
function AssignPerson({ propertyId, hasBillTo, exclude, onDone }: { propertyId: string; hasBillTo: boolean; exclude: string[]; onDone: () => void }) {
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [role, setRole] = useState<"bill_to" | "resident">(hasBillTo ? "resident" : "bill_to");
  const [startDate, setStartDate] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!who) return;
      run(async () => { await api(`/properties/${propertyId}/assign`, { body: { customerId: who.id, role, ...(startDate ? { startDate } : {}) } }); onDone(); });
    }}>
      {who ? <div className="row"><strong>{who.name}</strong><button type="button" className="btn" onClick={() => setWho(null)}>Change</button></div>
        : <CustomerPicker onPick={setWho} exclude={exclude} label="Customer (add new customers on the Customers page first)" />}
      <div className="formgrid">
        <label>As the
          <select value={role} onChange={(e) => setRole(e.target.value as "bill_to" | "resident")}>
            <option value="bill_to">{hasBillTo ? "New bill-to (replaces the current one)" : "Bill-to (gets the invoices)"}</option>
            <option value="resident">Resident (tenant; gets reminders)</option>
          </select>
        </label>
        <label>Starting<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
      </div>
      {role === "bill_to" && hasBillTo && <p className="muted" style={{ margin: 0 }}>The current bill-to&apos;s time ends the day before. Past invoices stay with them; the property&apos;s history stays with the property.</p>}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy || !who}>Add</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
