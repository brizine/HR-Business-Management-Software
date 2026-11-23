"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { CUSTOMER_PAGE_SIZES, DEFAULT_CUSTOMER_COLUMNS, parseCustomerFilters, type CustomerFilter } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useCustomFields } from "@/components/custom-fields";
import {
  BUILT_IN_VIEWS, Cell, ColumnPicker, CrmTabs, FilterChips, FilterEditor, Popover, allColumns, cellText, readLocal, writeLocal, type Col, type ListView,
} from "@/components/customer-list";
import { openTestCompany, useTestCompany } from "@/components/test-company";
import { CustomerFields, PropertyFields, customerBody, customerFormValue, propertyBody, propertyFormValue, useTags } from "@/components/customers";

const TABS = [["active", "Customers"], ["lead", "Leads"], ["cancelled", "Cancelled"], ["all", "All"]] as const;
const SIZES = CUSTOMER_PAGE_SIZES;
type ListResponse = { total: number; rows: any[]; counts: { active: number; lead: number; cancelled: number; current: number; all: number } };

/**
 * The Customers list, laid out like Homeworks' but compact: one header row (tabs, Export, Print,
 * New), one filter card (counts by status as small tabs, quick search, filter rules shown as chips,
 * saved views, columns), then the list with checkboxes for bulk actions, sortable columns and pages.
 * Everything chosen is kept in the address, so Back, refresh and sharing a link keep the view.
 */
function Customers() {
  const { me, can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { tags, reload: reloadTags } = useTags();
  const custom = useCustomFields("customer").data ?? [];
  const services = (useApi<{ id: string; name: string; active: boolean }[]>("/service-types").data ?? []).map((x) => ({ id: x.id, name: x.name }));
  const uid = me?.user.id ?? "anon";
  // The view lives in the address.
  const status = params.get("status") ?? "active";
  const filters = useMemo(() => parseCustomerFilters(params.get("f")), [params]);
  const sort = params.get("sort") ?? "name";
  const dir = (params.get("dir") === "desc" ? "desc" : "asc") as "asc" | "desc";
  const size = SIZES.includes(Number(params.get("size")) as never) ? Number(params.get("size")) : 50;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [q, setQ] = useState(params.get("q") ?? "");
  const setView = (patch: Record<string, string | null>, keepPage = false) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") u.delete(k); else u.set(k, v); }
    if (!keepPage) u.delete("page");
    router.replace(`/customers${u.toString() ? `?${u}` : ""}`, { scroll: false });
  };
  const setFilters = (f: CustomerFilter[]) => setView({ f: f.length ? JSON.stringify(f) : null });
  // Quick search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { if (q !== (params.get("q") ?? "")) setView({ q: q.trim() || null }); }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  // "See all customers…" from the top bar's search lands here with ?q=.
  const asked = params.get("q");
  useEffect(() => { if (asked !== null && asked !== q) setQ(asked); }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useMemo(() => {
    const u = new URLSearchParams({ status, sort, dir, limit: String(size), offset: String((page - 1) * size) });
    if (params.get("q")) u.set("q", params.get("q")!);
    if (filters.length) u.set("filters", JSON.stringify(filters));
    return u.toString();
  }, [status, sort, dir, size, page, filters, params]);
  const list = useApi<ListResponse>(`/customers?${query}`);
  const counts = list.data?.counts;

  // Columns: each person's own choice and order, kept in this browser.
  const colsKey = `crewdesk.customers.columns.${uid}`;
  const [shown, setShown] = useState<string[]>(DEFAULT_CUSTOMER_COLUMNS);
  useEffect(() => { setShown(readLocal(colsKey, DEFAULT_CUSTOMER_COLUMNS)); }, [colsKey]);
  const cols = allColumns(custom);
  const visible = shown.map((k) => cols.find((c) => c.key === k)).filter((c): c is Col => !!c);
  const saveCols = (k: string[]) => { setShown(k); writeLocal(colsKey, k); };

  // Saved views (this person's, in this browser) and the ready-made ones.
  const viewsKey = `crewdesk.customers.views.${uid}`;
  const [views, setViews] = useState<ListView[]>([]);
  useEffect(() => { setViews(readLocal(viewsKey, [])); }, [viewsKey]);
  const applyView = (v: ListView) => {
    setQ(v.q);
    const u = new URLSearchParams();
    if (v.status !== "active") u.set("status", v.status);
    if (v.q) u.set("q", v.q);
    if (v.filters.length) u.set("f", JSON.stringify(v.filters));
    if (v.sort !== "name") u.set("sort", v.sort);
    if (v.dir === "desc") u.set("dir", "desc");
    if (size !== 50) u.set("size", String(size));
    if (v.columns) saveCols(v.columns);
    router.replace(`/customers${u.toString() ? `?${u}` : ""}`, { scroll: false });
    setOpen(null);
  };
  const saveView = () => {
    const name = prompt("Name this view", "")?.trim();
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, status, q: params.get("q") ?? "", filters, sort, dir, columns: shown }];
    setViews(next); writeLocal(viewsKey, next);
    setOpen(null);
    setNotice(`Saved the view “${name}”. Find it under Views.`);
  };
  const deleteView = (name: string) => { const next = views.filter((v) => v.name !== name); setViews(next); writeLocal(viewsKey, next); };

  // Popovers: which is open (filter editor for a new rule or rule i, columns, views, menus).
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (k: string) => (o: boolean) => setOpen(o ? k : null);

  // Selection and bulk actions.
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { setPicked([]); }, [query]);
  const rows = list.data?.rows ?? [];
  const allPicked = rows.length > 0 && rows.every((r) => picked.includes(r.id));
  const bulk = useAction();
  const runBulk = (body: Record<string, unknown>, done: string) => bulk.run(async () => {
    const r = await api<{ changed: number; skipped: number }>("/customers/bulk", { body: { ids: picked, ...body } });
    setNotice(`${done}: ${r.changed} changed${r.skipped ? `, ${r.skipped} cancelled left as they are` : ""}.`);
    setOpen(null);
    await list.reload();
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [printOnly, setPrintOnly] = useState<string[] | null>(null);
  useEffect(() => {
    if (!printOnly) return;
    const t = setTimeout(() => { window.print(); setPrintOnly(null); }, 50);
    return () => clearTimeout(t);
  }, [printOnly]);

  // Export: every matching customer (up to 5,000), the columns shown, in order.
  const exporting = useAction();
  const exportCsv = (only?: string[]) => exporting.run(async () => {
    const u = new URLSearchParams(query);
    u.set("export", "1"); u.set("limit", "5000"); u.set("offset", "0");
    const data = only ? { rows: rows.filter((r) => only.includes(r.id)) } : await api<ListResponse>(`/customers?${u}`);
    const cell = (v: string) => { const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
    const lines = [visible.map((c) => c.label), ...data.rows.map((r) => visible.map((c) => cellText(c, r, tags)))];
    const blob = new Blob([lines.map((l) => l.map(cell).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const [adding, setAdding] = useState<null | "active" | "lead">(null);
  const [samples, setSamples] = useState(false);
  useNewForm(() => setAdding("active"));
  const testCo = useTestCompany();
  const test = testCo.data && !testCo.data.isTest && testCo.data.exists && testCo.data.canOpen ? testCo.data : null;
  const switching = useAction();
  const total = list.data?.total ?? 0;
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(page * size, total);
  const sortBy = (k: string) => setView({ sort: k === "name" && sort !== "name" ? null : k, dir: sort === k && dir === "asc" ? "desc" : null }, true);
  const editing = open?.startsWith("filter:") ? Number(open.slice(7)) : null;
  const shownRows = printOnly ? rows.filter((r) => printOnly.includes(r.id)) : rows;

  return (
    <>
      <PageHead title="Customers" sub={<CrmTabs at="customers" />}>
        <button className="btn no-print" disabled={exporting.busy} onClick={() => exportCsv()}><Icon name="download" size={14} /> Export</button>
        <button className="btn no-print" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
        {(test || can("admin", "customers")) && (
          <Popover label={<Icon name="more" size={16} />} title="More" open={open === "more"} setOpen={toggle("more")} align="right" buttonClass="btn no-print">
            <div className="cl-menu">
              {can("admin", "customers") && <button type="button" onClick={() => { setSamples(true); setOpen(null); }}>Sample customers…</button>}
              {test && <button type="button" disabled={switching.busy} onClick={() => switching.run(openTestCompany)}>Open test company</button>}
              <Link href="/custom-fields">Custom fields…</Link>
            </div>
          </Popover>
        )}
        <Popover label={<><Icon name="plus" size={14} /> New ▾</>} open={open === "new"} setOpen={toggle("new")} align="right" buttonClass="btn primary no-print">
          <div className="cl-menu">
            <button type="button" onClick={() => { setAdding("active"); setOpen(null); }}>Customer</button>
            <button type="button" onClick={() => { setAdding("lead"); setOpen(null); }}>Lead</button>
            <Link href="/properties?new=1">Property</Link>
          </div>
        </Popover>
      </PageHead>
      <ErrorBox error={switching.error ?? exporting.error} />
      {samples && <SampleCustomersCard onChange={() => { list.reload(); reloadTags(); }} onClose={() => setSamples(false)} />}
      {adding && <AddCustomer key={adding} tags={tags} lead={adding === "lead"} onCancel={() => setAdding(null)} onSaved={(id) => router.push(`/customers/${id}`)} />}
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}

      <section className="card cl-bar no-print" aria-label="Find customers">
        <div className="cl-bar-row">
          <div className="cl-stats" role="tablist" aria-label="Status">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? "on" : ""} onClick={() => setView({ status: k === "active" ? null : k })}>
                {l} <b>{counts ? counts[k as keyof typeof counts].toLocaleString() : "·"}</b>
              </button>
            ))}
          </div>
          <input className="cl-search" type="search" placeholder="Quick search: name, phone, email, address, #" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quick customer search" />
          <Popover label={<><Icon name="plus" size={14} /> Filter</>} open={open === "filter:new"} setOpen={toggle("filter:new")} className="cl-pop-wide">
            <FilterEditor custom={custom} tags={tags} services={services} onCancel={() => setOpen(null)} onApply={(r) => { setFilters([...filters, r]); setOpen(null); }} />
          </Popover>
          <Popover label={<>Views ▾</>} open={open === "views"} setOpen={toggle("views")} align="right">
            <div className="cl-menu">
              <div className="todo-label">Ready-made</div>
              {BUILT_IN_VIEWS().map((v) => <button key={v.name} type="button" onClick={() => applyView(v)}>{v.name}</button>)}
              {views.length > 0 && <div className="todo-label">Yours</div>}
              {views.map((v) => (
                <div key={v.name} className="cl-menu-row">
                  <button type="button" onClick={() => applyView(v)}>{v.name}</button>
                  <button type="button" className="cl-chip-x" aria-label={`Delete the view ${v.name}`} onClick={() => deleteView(v.name)}>✕</button>
                </div>
              ))}
              <hr />
              <button type="button" onClick={saveView}>Save this view…</button>
              <button type="button" onClick={() => applyView({ name: "", status: "active", q: "", filters: [], sort: "name", dir: "asc" })}>Reset to all customers</button>
            </div>
          </Popover>
          <Popover label={<>Columns {visible.length}/{cols.length}</>} open={open === "columns"} setOpen={toggle("columns")} align="right" className="cl-pop-wide">
            <ColumnPicker cols={cols} shown={shown} onChange={saveCols} />
          </Popover>
        </div>
        <FilterChips filters={filters} custom={custom} tags={tags} services={services} onEdit={(i) => setOpen(`filter:${i}`)}
          onRemove={(i) => setFilters(filters.filter((_, j) => j !== i))} onClear={() => setFilters([])} />
        {editing !== null && filters[editing] && (
          <div className="cl-pop cl-pop-inline cl-pop-wide">
            <FilterEditor key={editing} initial={filters[editing]} custom={custom} tags={tags} services={services} onCancel={() => setOpen(null)}
              onApply={(r) => { setFilters(filters.map((x, j) => (j === editing ? r : x))); setOpen(null); }} onRemove={() => { setFilters(filters.filter((_, j) => j !== editing)); setOpen(null); }} />
          </div>
        )}
      </section>

      <ErrorBox error={list.error ?? bulk.error} />
      <div className="card tablewrap cl-table-card">
        {picked.length > 0 && (
          <div className="cl-bulk no-print" role="toolbar" aria-label="With the selected customers">
            <strong>{picked.length} selected</strong>
            <Popover label="Add tag ▾" open={open === "addtag"} setOpen={toggle("addtag")}>
              <div className="cl-menu">{tags.filter((t) => !t.archived).map((t) => <button key={t.id} type="button" disabled={bulk.busy} onClick={() => runBulk({ addTagIds: [t.id] }, `Tagged ${t.name}`)}>{t.name}</button>)}{!tags.length && <span className="muted">No tags yet.</span>}</div>
            </Popover>
            <Popover label="Remove tag ▾" open={open === "rmtag"} setOpen={toggle("rmtag")}>
              <div className="cl-menu">{tags.map((t) => <button key={t.id} type="button" disabled={bulk.busy} onClick={() => runBulk({ removeTagIds: [t.id] }, `Took off ${t.name}`)}>{t.name}</button>)}{!tags.length && <span className="muted">No tags yet.</span>}</div>
            </Popover>
            <Popover label="Change status ▾" open={open === "status"} setOpen={toggle("status")}>
              <div className="cl-menu">
                <button type="button" disabled={bulk.busy} onClick={() => runBulk({ status: "active" }, "Marked active")}>Active</button>
                <button type="button" disabled={bulk.busy} onClick={() => runBulk({ status: "lead" }, "Marked as leads")}>Lead</button>
                <span className="muted" style={{ fontSize: 12, padding: "4px 8px" }}>Cancel a customer from their page (it asks why).</span>
              </div>
            </Popover>
            <button type="button" className="btn" onClick={() => exportCsv(picked)}>Export selected</button>
            <button type="button" className="btn" onClick={() => setPrintOnly(picked)}>Print selected</button>
            <button type="button" className="linkbtn" onClick={() => setPicked([])}>Clear</button>
          </div>
        )}
        {shownRows.length ? (
          <table className="cl-table">
            <thead>
              <tr>
                <th className="no-print cl-check"><input type="checkbox" aria-label="Select all on this page" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])} /></th>
                {visible.map((c) => (
                  <th key={c.key} className={c.align === "right" ? "num" : undefined} aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                    {c.sort ? <button type="button" className="cl-sort" onClick={() => sortBy(c.key)}>{c.label}{sort === c.key ? (dir === "asc" ? " ▲" : " ▼") : ""}</button> : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{shownRows.map((r) => (
              <tr key={r.id} className={picked.includes(r.id) ? "picked" : undefined}>
                <td className="no-print cl-check"><input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                {visible.map((c) => <td key={c.key} className={c.align === "right" ? "num" : NO_WRAP.has(c.key) ? "nowrap" : undefined}><Cell col={c} c={r} tags={tags} /></td>)}
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{filters.length || params.get("q") ? "No customers match. Change or clear the filters." : status === "lead" ? "No leads." : "No customers yet. Add one, or load the sample customers to try things out."}</Empty>}
        {total > 0 && (
          <div className="cl-pager no-print">
            <span className="muted">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
            <div className="row" style={{ gap: 6 }}>
              <label className="row" style={{ gap: 6 }}>Rows<select value={size} onChange={(e) => setView({ size: e.target.value === "50" ? null : e.target.value })} aria-label="Rows per page">{SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <button type="button" className="btn" disabled={page <= 1} onClick={() => setView({ page: page - 1 > 1 ? String(page - 1) : null }, true)}>‹ Previous</button>
              <button type="button" className="btn" disabled={to >= total} onClick={() => setView({ page: String(page + 1) }, true)}>Next ›</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function AddCustomer({ tags, lead, onCancel, onSaved }: { tags: any[]; lead?: boolean; onCancel: () => void; onSaved: (id: string) => void }) {
  const [value, setValue] = useState(() => ({ ...customerFormValue(), status: lead ? "lead" : "active" }));
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
      <h2 style={{ fontSize: 16, margin: 0 }}>{lead ? "New lead" : "New customer"}</h2>
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
function SampleCustomersCard({ onChange, onClose }: { onChange: () => void; onClose: () => void }) {
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
      <button type="button" className="btn" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
  );
}

/** Short values that read badly when split over two lines. */
const NO_WRAP = new Set(["number", "phone", "altPhone", "status", "type", "since", "lastService", "nextService"]);

export default function Page() {
  return <Suspense><Customers /></Suspense>;
}
