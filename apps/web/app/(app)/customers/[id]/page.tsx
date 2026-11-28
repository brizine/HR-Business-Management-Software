"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { CUSTOMER_KIND_LABELS, customerName, statusWord, PROPERTY_ROLE_LABELS, formatAddress, formatPhone, type CustomerKind, type PropertyRole } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { LinkedTodos } from "@/components/todos";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { Icon } from "@/components/icons";
import { CustomerBilling } from "@/components/invoices";
import { CustomerCredits } from "@/components/credits";
import { CustomerPrepayments } from "@/components/prepayments";
import { CancelForm, CustomerFields, PropertyFields, TagChips, customerBody, customerFormValue, propertyBody, propertyFormValue, useTags } from "@/components/customers";
import { CustomFieldsCard } from "@/components/custom-fields";
import { CopyPhones, CustomerEmails, EmailComposer } from "@/components/customer-messages";
import { PaymentMethodsCard } from "@/components/payment-methods";
import { LinkedEstimates } from "@/components/estimates";
import { PropertyPackages } from "@/components/packages";
import { Popover } from "@/components/customer-list";
import { VisitFiles } from "@/components/visit-files";
import { CustomerCalls, CustomerTexts } from "@/components/texting";
import { CustomerAutomations } from "@/components/automations";
import { CustomerSchedulingPrefs } from "@/components/waitlist";
import { CustomerForms } from "@/components/visit-forms";
import { AccountBox, CallNotes, CustomerNotesBox, DeliveryBox, InvoiceDefaultsBox, JobsBox, PayPicker, PaymentsBox, PortalBox, StatsBox, Timeline } from "@/components/customer-page";

/**
 * A customer's page, laid out like Homeworks': Send, Create and More menus; tabs for details,
 * communication, and photos and documents; and two columns of boxes (main info, notes, jobs,
 * properties, estimates, invoices, payments, delivery, custom fields and stats on the left; the
 * account, call notes, timeline, cards on file, invoice settings, portal, contacts, prepayments
 * and credits on the right).
 */
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
  const [tab, setTab] = useState<"details" | "communication" | "files" | "automations">("details");
  const [panel, setPanel] = useState<null | "email" | "text" | "pay">(null);
  const texting = useApi<{ connected: boolean }>("/texting/settings");
  const [textFocus, setTextFocus] = useState(0);
  // From the Texts page: open Communication at the texts.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === "communication") { setTab("communication"); if (url.searchParams.get("texts")) setTextFocus((n) => n + 1); window.history.replaceState(window.history.state, "", url.pathname); }
  }, []);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const c = customer.data;
  if (customer.error) return <><PageHead title="Customer" /><ErrorBox error={customer.error} /></>;
  if (!c) return <PageHead title="Customer" sub="Loading…" />;
  const current = c.properties.filter((p: any) => !p.endDate);
  const past = c.properties.filter((p: any) => p.endDate);
  const person = [c.title, c.firstName, c.lastName].filter(Boolean).join(" ");
  const toggle = (k: string) => (o: boolean) => setOpen(o ? k : null);
  const reload = () => { customer.reload(); setVersion((v) => v + 1); };
  const viewAs = () => {
    // Open the tab now (browsers block tabs opened after a wait), then point it at the portal.
    const w = window.open("about:blank", "_blank");
    action.run(async () => {
      try { await api("/portal/view-as", { body: { customerId: id } }); } catch (e) { w?.close(); throw e; }
      if (w) w.location.href = "/portal"; else window.location.href = "/portal";
    });
  };
  const propOptions = current.filter((p: any) => p.status !== "cancelled");

  return (
    <>
      <PageHead title={c.name} before={<Link className="btn no-print" href="/customers" aria-label="Back to customers">←</Link>}
        sub={<>#{c.number} · {CUSTOMER_KIND_LABELS[c.kind as CustomerKind]} · <Badge value={c.status} text={statusWord(c.status)} />{c.sample && <> · <span className="tag tag-gray">Sample</span></>}</>}>
        {c.status !== "cancelled" && <button className="btn no-print" onClick={() => { setEditing(!editing); setTab("details"); }}>Edit</button>}
        <Popover label={<>Send ▾</>} open={open === "send"} setOpen={toggle("send")} align="right" buttonClass="btn no-print">
          <div className="cl-menu">
            <button type="button" disabled={!c.email} onClick={() => { setPanel("email"); setOpen(null); }}>Email{!c.email ? " (no email on file)" : "…"}</button>
            <button type="button" onClick={() => { setOpen(null); if (texting.data?.connected) { setTab("communication"); setTextFocus((n) => n + 1); } else setPanel("text"); }}>Text…</button>
          </div>
        </Popover>
        <Popover label={<>Create ▾</>} open={open === "create"} setOpen={toggle("create")} align="right" buttonClass="btn primary no-print">
          <div className="cl-menu">
            <Link href={`/visits/new?customerId=${id}`}>Work order</Link>
            <button type="button" onClick={() => { setPanel("pay"); setOpen(null); }}>Payment…</button>
            <Link href={`/estimates/new?customerId=${id}`}>Estimate</Link>
            <Link href={`/invoices/new?customerId=${id}`}>Invoice</Link>
            <Link href={`/todos?new=1&customerId=${id}`}>To-do</Link>
            {c.status !== "cancelled" && <button type="button" onClick={() => { setAddingProperty(true); setTab("details"); setOpen(null); }}>Property</button>}
          </div>
        </Popover>
        <Popover label={<Icon name="more" size={16} />} title="More" open={open === "more"} setOpen={toggle("more")} align="right" buttonClass="btn no-print">
          <div className="cl-menu">
            <button type="button" onClick={() => { setOpen(null); setTimeout(() => window.print(), 50); }}>Print customer</button>
            <button type="button" disabled={action.busy} onClick={() => { setOpen(null); viewAs(); }}>View as customer</button>
            {c.status !== "cancelled"
              ? <button type="button" className="bad-text" onClick={() => { setCancelling(true); setOpen(null); }}>Make inactive…</button>
              : <button type="button" disabled={action.busy} onClick={() => { setOpen(null); action.run(async () => { await api(`/customers/${id}/reactivate`, { method: "POST" }); reload(); }); }}>Reactivate</button>}
            {can("admin", "customers") && (c.status === "lead" || c.sample || c.properties.length === 0) && (
              <button type="button" className="bad-text" disabled={action.busy} onClick={() => { setOpen(null); if (confirm(`Delete ${c.name}? This can't be undone.`)) action.run(async () => { await api(`/customers/${id}`, { method: "DELETE" }); router.push("/customers"); }); }}>Delete</button>
            )}
          </div>
        </Popover>
      </PageHead>
      <ErrorBox error={action.error} />
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}
      {panel === "email" && (
        <EmailComposer selection={{ ids: [id] }} audience={c.name} onClose={() => setPanel(null)}
          onSent={() => { setPanel(null); setNotice(`Emailing ${c.name}. It shows on the timeline once it's gone.`); setTimeout(reload, 3000); }} />
      )}
      {panel === "text" && <CopyPhones selection={{ ids: [id] }} onClose={() => setPanel(null)} />}
      {panel === "pay" && <PayPicker customerId={id} onClose={() => setPanel(null)} />}
      {cancelling && (
        <>
          {current.some((p: any) => p.role === "bill_to" && p.status === "active") && (
            <p className="muted">Properties they&apos;re the bill-to for will be made inactive too. Properties where they&apos;re only a resident stay as they are.</p>
          )}
          <CancelForm what="customer" onClose={() => setCancelling(false)} onSubmit={async (body) => { await api(`/customers/${id}/cancel`, { body }); reload(); }} />
        </>
      )}

      <nav className="cal-seg cp-tabs no-print" aria-label="Customer sections">
        {([["details", "Customer details"], ["communication", "Communication"], ["files", "Photos & documents"], ["automations", "Automations"]] as const).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "automations" && <CustomerAutomations customerId={id} name={c.name} />}
      {tab === "communication" && (
        <div className="cp-grid">
          <div className="cp-col">
            <CustomerTexts key={textFocus} customerId={id} focus={textFocus > 0} />
            <CustomerCalls customerId={id} />
            <CallNotes customerId={id} customerName={c.name} onSaved={() => setVersion((v) => v + 1)} />
            <CustomerEmails customerId={id} />
          </div>
          <div className="cp-col"><Timeline customerId={id} version={version} title="Calls, messages, emails and notes" filter /></div>
        </div>
      )}
      {tab === "files" && (
        <div className="card"><VisitFiles base={`/customers/${id}`} canAdd canManage /></div>
      )}
      {tab === "details" && (editing ? <EditCustomer customer={c} tags={tags} onDone={() => { setEditing(false); reload(); }} /> : (
        <div className="cp-grid">
          <div className="cp-col">
            <div className="card">
              <h2 className="cp-h">Main info</h2>
              <dl className="facts cp-facts">
                {c.kind !== "residential" && person && <><dt>Contact</dt><dd>{person}</dd></>}
                {c.kind === "residential" && c.title && <><dt>Name</dt><dd>{person}</dd></>}
                <dt>Phone</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{formatPhone(c.phone)}</a> : "—"}</dd>
                <dt>Email</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</dd>
                <dt>Billing address</dt><dd>{formatAddress({ street: c.billingStreet, city: c.billingCity, state: c.billingState, zip: c.billingZip }) || "—"}</dd>
                <dt>Tags</dt><dd><TagChips ids={c.tagIds} tags={tags} /> {!c.tagIds.length && "—"}</dd>
                {more && (
                  <>
                    <dt>Customer #</dt><dd>{c.number}</dd>
                    <dt>Other phone</dt><dd>{c.altPhone ? <a href={`tel:${c.altPhone}`}>{formatPhone(c.altPhone)}</a> : "—"}</dd>
                    <dt>County</dt><dd>{c.county ?? "—"}</dd>
                    <dt>Heard about us</dt><dd>{c.source ?? "—"}</dd>
                    <dt>Customer since</dt><dd>{fmtDate(c.createdAt)}</dd>
                    <dt>Tax exempt</dt><dd>{c.taxExempt ? `Yes${c.taxExemptNumber ? ` (${c.taxExemptNumber})` : ""}` : "No"}</dd>
                    <dt>Discount</dt><dd>{c.discountPercent ? `${c.discountPercent}%` : "None"}</dd>
                  </>
                )}
              </dl>
              <button type="button" className="btn no-print" style={{ marginTop: 8 }} onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>
            </div>
            <CustomerNotesBox key={`notes-${c.updatedAt}`} customer={c} onSaved={reload} />
            <JobsBox customerId={id} />
            <PropertyPackages customerId={id} active={c.status !== "cancelled"}
              properties={propOptions.filter((p: any) => p.role === "bill_to").map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", "), lawnSqFt: p.lawnSqFt, frontSqFt: p.frontSqFt, backSqFt: p.backSqFt, otherSqFt: p.otherSqFt, custom: p.custom }))} />
            <CustomerForms customerId={id} />
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="cp-h">Properties</h2>
                {c.status !== "cancelled" && <button className="btn no-print" onClick={() => setAddingProperty(!addingProperty)}>Add a property</button>}
              </div>
              {addingProperty && <AddProperty customerId={id} tags={tags} onDone={() => { setAddingProperty(false); reload(); }} />}
              {current.length ? <PropertyTable rows={current} tags={tags} /> : <Empty>Not on any property yet.</Empty>}
              {past.length > 0 && (
                <>
                  <button className="btn" onClick={() => setShowPast(!showPast)}>{showPast ? "Hide" : "Show"} past properties ({past.length})</button>
                  {showPast && <PropertyTable rows={past} tags={tags} past />}
                </>
              )}
            </div>
            <LinkedEstimates customerId={id} />
            <CustomerBilling customerId={id} key={`billing-${creditVersion}`} hideSummary />
            <PaymentsBox customerId={id} key={`pays-${creditVersion}`} />
            <DeliveryBox customer={c} onSaved={reload} />
            <div className="card"><h2 className="cp-h">Scheduling</h2><CustomerSchedulingPrefs customer={c} onSaved={reload} /></div>
            <CustomFieldsCard target="customer" id={id} canEdit values={c.custom ?? {}} onSaved={() => customer.reload()} />
            <StatsBox customerId={id} />
            <LinkedTodos customerId={id} customer={{ id, name: customerName(c) }} />
          </div>
          <div className="cp-col">
            <AccountBox key={`acct-${creditVersion}-${version}`} customerId={id} name={c.name} onPay={() => setPanel("pay")} />
            <CallNotes customerId={id} customerName={c.name} onSaved={() => setVersion((v) => v + 1)} />
            <Timeline customerId={id} version={version} />
            <PaymentMethodsCard customerId={id} />
            <InvoiceDefaultsBox customer={c} onEdit={() => setEditing(true)} onSaved={reload} />
            <PortalBox customer={c} busy={action.busy} onViewAs={viewAs} />
            <div className="card">
              <h2 className="cp-h">Other contacts</h2>
              {c.contacts.length ? (
                <ul className="plain-list">
                  {c.contacts.map((k: any) => (
                    <li key={k.id}>
                      <strong>{k.name}</strong>{k.relation && <span className="muted"> · {k.relation}</span>}{k.getsInvoices && <span className="badge" style={{ marginLeft: 6 }}>gets invoices</span>}
                      <div className="muted">{[k.email, k.phone && formatPhone(k.phone)].filter(Boolean).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted" style={{ margin: 0 }}>None. Add a spouse, property manager or accounts payable contact with Edit.</p>}
            </div>
            <CustomerPrepayments customerId={id} onChange={() => setCreditVersion((v) => v + 1)}
              properties={propOptions.map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", "), lawnSqFt: p.lawnSqFt, frontSqFt: p.frontSqFt, backSqFt: p.backSqFt, otherSqFt: p.otherSqFt, custom: p.custom }))} />
            <CustomerCredits customerId={id} onChange={() => setCreditVersion((v) => v + 1)}
              properties={propOptions.map((p: any) => ({ id: p.id, address: [p.street, p.city].filter(Boolean).join(", ") }))} />
            {c.cancellations.length > 0 && (
              <div className="card">
                <h2 className="cp-h">Made inactive</h2>
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
            <div className="card"><VisitFiles base={`/customers/${id}`} canAdd canManage /></div>
          </div>
        </div>
      ))}
    </>
  );
}

function PropertyTable({ rows, tags, past }: { rows: any[]; tags: any[]; past?: boolean }) {
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Address</th><th>Role</th><th>Lawn</th><th>Last serviced</th><th>Next service</th><th>Tags</th><th>{past ? "Dates" : "Status"}</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.assignmentId}>
            <td><Link href={`/properties/${p.id}`}><strong>{p.street}</strong></Link>{p.name && <div className="muted">{p.name}</div>}<div className="muted">{[p.city, p.zip].filter(Boolean).join(" ")}</div></td>
            <td>{PROPERTY_ROLE_LABELS[p.role as PropertyRole]}</td>
            <td className="nowrap">{p.lawnSqFt ? `${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : "—"}{p.mapCode && <div className="muted">MC {p.mapCode}</div>}</td>
            <td className="nowrap">{p.lastService ? fmtDate(p.lastService) : "—"}</td>
            <td className="nowrap">{p.nextService ? fmtDate(p.nextService) : "—"}</td>
            <td><TagChips ids={p.tagIds} tags={tags} /></td>
            <td>{past ? `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}` : <Badge value={p.status} text={statusWord(p.status)} />}</td>
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
