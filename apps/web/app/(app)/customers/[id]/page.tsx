"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { CUSTOMER_KIND_LABELS, DELIVERY_LABELS, PROPERTY_ROLE_LABELS, formatAddress, formatPhone, type CustomerKind, type DeliveryMethod, type PropertyRole } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { CustomerBilling } from "@/components/invoices";
import { CustomerCredits } from "@/components/credits";
import { CustomerPrepayments } from "@/components/prepayments";
import { CancelForm, CustomerFields, PropertyFields, TagChips, customerBody, customerFormValue, propertyBody, propertyFormValue, useTags } from "@/components/customers";

export default function CustomerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const router = useRouter();
  const { tags } = useTags();
  const customer = useApi<any>(`/customers/${id}`);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [addingProperty, setAddingProperty] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [creditVersion, setCreditVersion] = useState(0);
  const action = useAction();
  const c = customer.data;
  if (customer.error) return <><PageHead title="Customer" /><ErrorBox error={customer.error} /></>;
  if (!c) return <PageHead title="Customer" sub="Loading…" />;
  const current = c.properties.filter((p: any) => !p.endDate);
  const past = c.properties.filter((p: any) => p.endDate);
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");

  return (
    <>
      <PageHead title={c.name} before={<Link className="btn" href="/customers" aria-label="Back to customers">←</Link>}
        sub={<>#{c.number} · {CUSTOMER_KIND_LABELS[c.kind as CustomerKind]} · <Badge value={c.status} />{c.sample && <> · <span className="tag tag-gray">Sample</span></>}</>}>
        {c.status !== "cancelled" && <button className="btn" onClick={() => setEditing(!editing)}>Edit</button>}
        <button className="btn" title="Opens the customer portal as this customer sees it (read-only)" disabled={action.busy} onClick={() => {
          // Open the tab now (browsers block tabs opened after a wait), then point it at the portal.
          const tab = window.open("about:blank", "_blank");
          action.run(async () => {
            try { await api("/portal/view-as", { body: { customerId: id } }); } catch (e) { tab?.close(); throw e; }
            if (tab) tab.location.href = "/portal"; else window.location.href = "/portal";
          });
        }}>View as customer</button>
        {c.status !== "cancelled"
          ? <button className="btn danger" onClick={() => setCancelling(!cancelling)}>Cancel customer</button>
          : <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { await api(`/customers/${id}/reactivate`, { method: "POST" }); customer.reload(); })}>Reactivate</button>}
        {can("admin", "customers") && (c.status === "lead" || c.sample || c.properties.length === 0) && (
          <button className="btn danger" disabled={action.busy} onClick={() => confirm(`Delete ${c.name}? This can't be undone.`) && action.run(async () => { await api(`/customers/${id}`, { method: "DELETE" }); router.push("/customers"); })}>Delete</button>
        )}
      </PageHead>
      <ErrorBox error={action.error} />
      {cancelling && (
        <>
          {current.some((p: any) => p.role === "bill_to" && p.status === "active") && (
            <p className="muted">Properties they&apos;re the bill-to for will be cancelled too. Properties where they&apos;re only a resident stay as they are.</p>
          )}
          <CancelForm what="customer" onClose={() => setCancelling(false)} onSubmit={async (body) => { await api(`/customers/${id}/cancel`, { body }); customer.reload(); }} />
        </>
      )}
      {editing ? <EditCustomer customer={c} tags={tags} onDone={() => { setEditing(false); customer.reload(); }} /> : (
        <div className="grid cols-2">
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Contact &amp; billing</h2>
            <dl className="facts">
              {c.kind !== "residential" && person && <><dt>Contact</dt><dd>{person}</dd></>}
              <dt>Email</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</dd>
              <dt>Phone</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{formatPhone(c.phone)}</a> : "—"}{c.altPhone && <div>{formatPhone(c.altPhone)}</div>}</dd>
              <dt>Billing address</dt><dd>{formatAddress({ street: c.billingStreet, city: c.billingCity, state: c.billingState, zip: c.billingZip }) || "—"}</dd>
              <dt>Invoices by</dt><dd>{c.delivery.map((d: DeliveryMethod) => DELIVERY_LABELS[d]).join(", ")}{c.poRequired && " · needs a PO number"}</dd>
              <dt>Heard about us</dt><dd>{c.source ?? "—"}</dd>
              <dt>Tags</dt><dd><TagChips ids={c.tagIds} tags={tags} /> {!c.tagIds.length && "—"}</dd>
              <dt>Customer since</dt><dd>{fmtDate(c.createdAt)}</dd>
            </dl>
            {c.notes && <p style={{ whiteSpace: "pre-wrap" }}>{c.notes}</p>}
          </div>
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Other contacts</h2>
            {c.contacts.length ? (
              <ul className="plain-list">
                {c.contacts.map((k: any) => (
                  <li key={k.id}>
                    <strong>{k.name}</strong>{k.relation && <span className="muted"> · {k.relation}</span>}{k.getsInvoices && <span className="badge" style={{ marginLeft: 6 }}>gets invoices</span>}
                    <div className="muted">{[k.email, k.phone && formatPhone(k.phone)].filter(Boolean).join(" · ")}</div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">None. Add a spouse, property manager or accounts payable contact with Edit.</p>}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Properties</h2>
          {c.status !== "cancelled" && <button className="btn" onClick={() => setAddingProperty(!addingProperty)}>Add a property</button>}
        </div>
        {addingProperty && <AddProperty customerId={id} tags={tags} onDone={() => { setAddingProperty(false); customer.reload(); }} />}
        {current.length ? <PropertyTable rows={current} tags={tags} /> : <Empty>Not on any property yet.</Empty>}
        {past.length > 0 && (
          <>
            <button className="btn" onClick={() => setShowPast(!showPast)}>{showPast ? "Hide" : "Show"} past properties ({past.length})</button>
            {showPast && <PropertyTable rows={past} tags={tags} past />}
          </>
        )}
      </div>

      <CustomerBilling customerId={id} key={`billing-${creditVersion}`} />
      <CustomerPrepayments customerId={id} onChange={() => setCreditVersion((v) => v + 1)}
        properties={current.filter((p: any) => p.status !== "cancelled").map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", "), lawnSqFt: p.lawnSqFt }))} />
      <CustomerCredits customerId={id} onChange={() => setCreditVersion((v) => v + 1)}
        properties={current.filter((p: any) => p.status !== "cancelled").map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", ") }))} />

      {c.cancellations.length > 0 && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Cancellations</h2>
          <ul className="plain-list">
            {c.cancellations.map((x: any) => (
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

function PropertyTable({ rows, tags, past }: { rows: any[]; tags: any[]; past?: boolean }) {
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Address</th><th>Role</th><th>MC</th><th>Lawn</th><th>Tags</th><th>{past ? "Dates" : "Status"}</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.assignmentId}>
            <td><Link href={`/properties/${p.id}`}><strong>{p.street}</strong></Link>{p.name && <div className="muted">{p.name}</div>}<div className="muted">{[p.city, p.zip].filter(Boolean).join(" ")}</div></td>
            <td>{PROPERTY_ROLE_LABELS[p.role as PropertyRole]}</td>
            <td>{p.mapCode ?? <span className="muted">—</span>}</td>
            <td>{p.lawnSqFt ? `${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : "—"}</td>
            <td><TagChips ids={p.tagIds} tags={tags} /></td>
            <td>{past ? `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}` : <Badge value={p.status} />}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function EditCustomer({ customer, tags, onDone }: { customer: any; tags: any[]; onDone: () => void }) {
  const [value, setValue] = useState(customerFormValue(customer));
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/customers/${customer.id}`, { method: "PUT", body: customerBody(value) }); onDone(); }); }}>
      <CustomerFields value={value} onChange={setValue} tags={tags} showStatus={customer.status === "lead"} />
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function AddProperty({ customerId, tags, onDone }: { customerId: string; tags: any[]; onDone: () => void }) {
  const [value, setValue] = useState(propertyFormValue());
  const [role, setRole] = useState<"bill_to" | "resident">("bill_to");
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      const body = { ...propertyBody(value), ...(role === "bill_to" ? { billToCustomerId: customerId } : { residentIds: [customerId] }) };
      run(async () => { await api("/properties", { body }); onDone(); });
    }}>
      <p className="muted" style={{ margin: 0 }}>A new service address. To put this customer on an address that&apos;s already in Crewdesk, open that property and use &quot;Add a person&quot;.</p>
      <PropertyFields value={value} onChange={setValue} tags={tags} />
      <label>This customer is the
        <select value={role} onChange={(e) => setRole(e.target.value as "bill_to" | "resident")}>
          <option value="bill_to">Bill-to (gets the invoices)</option>
          <option value="resident">Resident (tenant; gets reminders)</option>
        </select>
      </label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Add property</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
