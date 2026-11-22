"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { CustomerPicker, PropertyFields, TagChips, TagFilter, propertyBody, propertyFormValue, tagQuery, useTags, type TagFilterState } from "@/components/customers";

export default function Properties() {
  const router = useRouter();
  const { tags } = useTags();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [mapCode, setMapCode] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilterState>({ all: [], not: [] });
  const [customerTags, setCustomerTags] = useState<TagFilterState>({ all: [], not: [] });
  const [adding, setAdding] = useState(false);
  useNewForm(() => setAdding(true));
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const params = [
    `status=${status}`, ...(query.trim() ? [`q=${encodeURIComponent(query.trim())}`] : []), ...(mapCode.trim() ? [`mapCode=${encodeURIComponent(mapCode.trim())}`] : []),
    ...tagQuery(tagFilter), ...tagQuery(customerTags, "customer"),
  ].join("&");
  const list = useApi<{ total: number; rows: any[] }>(`/properties?${params}`);
  const filtering = !!query.trim() || status !== "active" || !!mapCode.trim() || tagFilter.all.length + tagFilter.not.length + customerTags.all.length > 0;

  return (
    <>
      <PageHead title="Properties" sub={<span role="status">{list.data ? `${list.data.total} ${list.data.total === 1 ? "property" : "properties"}` : "Loading…"}</span>}>
        <Link className="btn" href="/customers">Customers</Link>
        <button className="btn primary" onClick={() => setAdding(!adding)}>Add property</button>
      </PageHead>
      {adding && <AddProperty tags={tags} onCancel={() => setAdding(false)} onSaved={(id) => router.push(`/properties/${id}`)} />}
      <form className="card filters" role="search" aria-label="Filter properties" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder="Address, ZIP, label or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>Map Code starts with
          <input value={mapCode} placeholder="e.g. 80, or none" onChange={(e) => setMapCode(e.target.value)} />
        </label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </select>
        </label>
        {filtering && <button type="button" className="btn" onClick={() => { setQ(""); setStatus("active"); setMapCode(""); setTagFilter({ all: [], not: [] }); setCustomerTags({ all: [], not: [] }); }}>Clear filters</button>}
        <TagFilter value={tagFilter} onChange={setTagFilter} tags={tags} label="Property tags" />
        <TagFilter value={customerTags} onChange={setCustomerTags} tags={tags} label="Bill-to customer's tags" requireOnly />
      </form>
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {list.data?.rows.length ? (
          <table>
            <thead><tr><th>Address</th><th>Bill-to</th><th>MC</th><th>Lawn</th><th>Tags</th><th>Status</th></tr></thead>
            <tbody>{list.data.rows.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/properties/${p.id}`}><strong>{p.street}</strong></Link>{p.name && <div className="muted">{p.name}</div>}<div className="muted">{[p.city, p.zip].filter(Boolean).join(" ")}</div></td>
                <td>{p.billTo ? <Link href={`/customers/${p.billTo.id}`}>{p.billTo.name}</Link> : <span className="muted">No bill-to</span>}</td>
                <td>{p.mapCode ?? <span className="muted">No MC</span>}</td>
                <td>{p.lawnSqFt ? `${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : "—"}</td>
                <td><TagChips ids={p.tagIds} tags={tags} /></td>
                <td><Badge value={p.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{filtering ? "No properties match your filters." : "No properties yet."}</Empty>}
        {list.data && list.data.total > list.data.rows.length && <p className="muted">Showing the first {list.data.rows.length}. Search or filter to narrow it down.</p>}
      </div>
    </>
  );
}

function AddProperty({ tags, onCancel, onSaved }: { tags: any[]; onCancel: () => void; onSaved: (id: string) => void }) {
  const [value, setValue] = useState(propertyFormValue());
  const [billTo, setBillTo] = useState<{ id: string; name: string } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => { const p = await api<{ id: string }>("/properties", { body: { ...propertyBody(value), ...(billTo ? { billToCustomerId: billTo.id } : {}) } }); onSaved(p.id); });
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>New property</h2>
      <PropertyFields value={value} onChange={setValue} tags={tags} />
      {billTo ? (
        <div className="row">Bill-to: <strong>{billTo.name}</strong><button type="button" className="btn" onClick={() => setBillTo(null)}>Change</button></div>
      ) : <CustomerPicker label="Bill-to customer (who gets the invoices; can be added later)" onPick={setBillTo} />}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save property</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
