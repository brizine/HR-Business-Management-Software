"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CUSTOMER_KIND_LABELS, formatPhone, type CustomerKind } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { openTestCompany, useTestCompany } from "@/components/test-company";
import {
  CustomerFields, PropertyFields, TagChips, TagFilter, customerBody, customerFormValue, propertyBody, propertyFormValue, tagQuery, useTags,
  type TagFilterState,
} from "@/components/customers";

const STATUSES = [["current", "Current"], ["active", "Active"], ["lead", "Leads"], ["cancelled", "Cancelled"], ["all", "All"]] as const;

function Customers() {
  const { can } = useAuth();
  const router = useRouter();
  const { tags, reload: reloadTags } = useTags();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("current");
  const [tagFilter, setTagFilter] = useState<TagFilterState>({ all: [], not: [] });
  const [adding, setAdding] = useState(false);
  useNewForm(() => setAdding(true));
  // Search waits for a pause in typing so the list doesn't reload on every key.
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  // "See all customers…" from the top bar's search opens this page searching for what was typed.
  // (Also when you're already on this page.)
  const asked = useSearchParams().get("q");
  useEffect(() => { if (asked) setQ(asked); }, [asked]);
  const params = [`status=${status}`, ...(query.trim() ? [`q=${encodeURIComponent(query.trim())}`] : []), ...tagQuery(tagFilter)].join("&");
  const list = useApi<{ total: number; rows: any[] }>(`/customers?${params}`);
  const filtering = !!query.trim() || status !== "current" || tagFilter.all.length + tagFilter.not.length > 0;
  const testCo = useTestCompany();
  const test = testCo.data && !testCo.data.isTest && testCo.data.exists && testCo.data.canOpen ? testCo.data : null;
  const switching = useAction();

  return (
    <>
      <PageHead title="Customers" sub={<span role="status">{list.data ? `${list.data.total} ${list.data.total === 1 ? "customer" : "customers"}` : "Loading…"}</span>}>
        {test && <button className="btn" disabled={switching.busy} onClick={() => switching.run(openTestCompany)}>Open test company</button>}
        <Link className="btn" href="/properties">Properties</Link>
        <button className="btn primary" onClick={() => setAdding(!adding)}>Add customer</button>
      </PageHead>
      <ErrorBox error={switching.error} />
      {can("admin", "customers") && <SampleCustomersCard onChange={() => { list.reload(); reloadTags(); }} />}
      {adding && <AddCustomer tags={tags} onCancel={() => setAdding(false)} onSaved={(id) => router.push(`/customers/${id}`)} />}
      <form className="card filters" role="search" aria-label="Filter customers" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder="Name, phone, email, address, #" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {filtering && <button type="button" className="btn" onClick={() => { setQ(""); setStatus("current"); setTagFilter({ all: [], not: [] }); }}>Clear filters</button>}
        <TagFilter value={tagFilter} onChange={setTagFilter} tags={tags} />
      </form>
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {list.data?.rows.length ? (
          <table>
            <thead><tr><th>#</th><th>Customer</th><th>Contact</th><th>Service address</th><th>Properties</th><th>Tags</th><th>Status</th></tr></thead>
            <tbody>{list.data.rows.map((c) => (
              <tr key={c.id}>
                <td className="muted">{c.number}</td>
                <td>
                  <Link href={`/customers/${c.id}`}><strong>{c.name}</strong></Link>
                  {c.kind !== "residential" && <div className="muted">{CUSTOMER_KIND_LABELS[c.kind as CustomerKind]}{c.firstName || c.lastName ? ` · ${[c.firstName, c.lastName].filter(Boolean).join(" ")}` : ""}</div>}
                </td>
                <td>{c.phone ? formatPhone(c.phone) : ""}{c.email && <div className="muted">{c.email}</div>}</td>
                <td>{c.address ?? <span className="muted">—</span>}</td>
                <td>{c.propertyCount}</td>
                <td><TagChips ids={c.tagIds} tags={tags} /></td>
                <td><Badge value={c.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{filtering ? "No customers match your filters." : "No customers yet. Add one, or load the sample customers to try things out."}</Empty>}
        {list.data && list.data.total > list.data.rows.length && <p className="muted">Showing the first {list.data.rows.length}. Search or filter to narrow it down.</p>}
      </div>
    </>
  );
}

function AddCustomer({ tags, onCancel, onSaved }: { tags: any[]; onCancel: () => void; onSaved: (id: string) => void }) {
  const [value, setValue] = useState(customerFormValue());
  const [withProperty, setWithProperty] = useState(true);
  const [sameAsBilling, setSameAsBilling] = useState(true);
  const [property, setProperty] = useState(propertyFormValue());
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const prop = sameAsBilling
        ? { ...property, street: value.billingStreet, city: value.billingCity, state: value.billingState, zip: value.billingZip }
        : property;
      const body = { ...customerBody(value), ...(withProperty ? { property: propertyBody(prop) } : {}) };
      run(async () => { const c = await api<{ id: string }>("/customers", { body }); onSaved(c.id); });
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>New customer</h2>
      <CustomerFields value={value} onChange={setValue} tags={tags} showStatus />
      <label className="check"><input type="checkbox" checked={withProperty} onChange={(e) => setWithProperty(e.target.checked)} /> Add their service address now (they&apos;ll be its bill-to)</label>
      {withProperty && (
        <div className="card inset stack">
          <label className="check"><input type="checkbox" checked={sameAsBilling} onChange={(e) => setSameAsBilling(e.target.checked)} /> Service address is the billing address</label>
          {sameAsBilling && !value.billingStreet && <p className="muted" style={{ margin: 0 }}>Fill in the billing address above, or untick this to enter the service address.</p>}
          <PropertyFields value={sameAsBilling ? { ...property, street: value.billingStreet, city: value.billingCity, state: value.billingState, zip: value.billingZip } : property}
            onChange={(p) => setProperty(sameAsBilling ? { ...p, street: property.street, city: property.city, state: property.state, zip: property.zip } : p)} tags={tags} />
        </div>
      )}
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>Save customer</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Admins: load or remove the 10 sample customers used for testing. */
function SampleCustomersCard({ onChange }: { onChange: () => void }) {
  const samples = useApi<{ count: number }>("/crm/sample-customers");
  const { busy, error, run } = useAction();
  if (!samples.data) return null;
  const count = samples.data.count;
  return (
    <div className="card row" style={{ justifyContent: "space-between" }}>
      <div>
        <strong>Sample customers</strong>
        <div className="muted">
          {count ? `${count} sample customers are loaded (tagged Sample). Remove them before real customers move over.`
            : "Load 10 made-up accounts (plus 2 tenants) that cover the tricky cases: paper invoices, a landlord with tenants, a property manager, a PO-number account, an HOA and more."}
        </div>
        <ErrorBox error={error} />
      </div>
      {count ? (
        <button className="btn danger" disabled={busy} onClick={() => confirm("Remove all sample customers and their properties?") && run(async () => { await api("/crm/sample-customers", { method: "DELETE" }); samples.reload(); onChange(); })}>Remove sample customers</button>
      ) : (
        <button className="btn" disabled={busy} onClick={() => run(async () => { await api("/crm/sample-customers", { method: "POST" }); samples.reload(); onChange(); })}>Load sample customers</button>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Customers /></Suspense>;
}
