"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Popover, readLocal, writeLocal } from "@/components/customer-list";
import { Icon } from "@/components/icons";
import { useTags } from "@/components/customers";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import {
  AddFilter, BUILT_IN_WAIT_VIEWS, BoardPicker, BulkMenu, Columns, DEFAULT_WL_COLUMNS, EditWorkOrders, SaveView, SelectionBreakdown, WaitMap, WaitTable, WorkloadStrip,
  applyFilters, badgeLegend, describeFilter, exportCsv, serviceColors, sortRows, totalsOf,
  type Filter, type SavedView, type WaitData, type WaitView,
} from "@/components/waitlist";

const hours = (min: number) => (min / 60).toFixed(1);

/**
 * The waiting list (from the Crewdesk plan): everything that needs doing with no date yet. Views
 * and filter chips on top, then the map, the week's workload, and the list; select rows or pins and
 * Edit work orders schedules them.
 */
export default function WaitingListPage() {
  const { can } = useAuth();
  const isAdmin = can("admin", "customers");
  const [view, setViewState] = useState<WaitView>(() => readLocal("wl-view", BUILT_IN_WAIT_VIEWS[0]));
  const setView = (v: WaitView) => { setViewState(v); writeLocal("wl-view", v); };
  const upcoming = view.filters.some((f) => f.key === "upcoming");
  const data = useApi<WaitData>(`/waitlist${upcoming ? "?upcoming=1" : ""}`);
  const views = useApi<SavedView[]>("/waitlist/views?page=waitlist");
  const [q, setQ] = useState(() => view.filters.find((f) => f.key === "q")?.value ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ date?: string; crewId?: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limit, setLimit] = useState(300);
  const [workKey, setWorkKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const act = useAction();

  // The search box is a filter too (so it saves with a view), applied as you stop typing.
  useEffect(() => {
    const t = setTimeout(() => {
      const rest = view.filters.filter((f) => f.key !== "q");
      const next = q.trim() ? [...rest, { key: "q", value: q.trim() }] : rest;
      if (JSON.stringify(next) !== JSON.stringify(view.filters)) setView({ ...view, filters: next });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const d = data.data;
  const all = d?.rows ?? [];
  // Filtered and sorted once, so the map, the list and the export agree.
  const shown = useMemo(() => sortRows(applyFilters(all, view.filters), view.sort), [all, view.filters, view.sort]);
  // Drop selections that the filters hide (so totals and the Edit window match what you see).
  useEffect(() => {
    if (!d) return;
    const ids = new Set(shown.map((r) => r.id));
    if ([...selected].some((id) => !ids.has(id))) setSelected(new Set([...selected].filter((id) => ids.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const colors = useMemo(() => serviceColors(all), [all]);
  const { tags } = useTags();
  const tagNames = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags]);
  const services = useMemo(() => new Map(all.map((r) => [r.service.id ?? `name:${r.service.name}`, r.service.name])), [all]);
  const picked = shown.filter((r) => selected.has(r.id));
  const pickedTotals = totalsOf(picked);
  const crews = d?.crews ?? [];
  const fitKey = JSON.stringify(view.filters.filter((f) => f.key !== "q")) + (d ? "1" : "0");

  const removeFilter = (i: number) => {
    const f = view.filters[i];
    if (f.key === "q") setQ("");
    setView({ ...view, filters: view.filters.filter((_, j) => j !== i) });
  };
  const onSort = (key: string) => setView({ ...view, sort: { key, dir: view.sort?.key === key && view.sort.dir === "asc" ? "desc" : "asc" } });
  const toggle = (ids: string[]) => {
    const n = new Set(selected);
    const allOn = ids.every((id) => n.has(id));
    for (const id of ids) if (allOn) n.delete(id); else n.add(id);
    setSelected(n);
  };
  const done = (msg: string) => { setNotice(msg); setSelected(new Set()); setEdit(null); data.reload(); setWorkKey((k) => k + 1); };
  const bulk = (body: Record<string, unknown>, label: string) => act.run(async () => {
    const r = await api<{ done: number; kept: number }>("/waitlist/bulk", { method: "POST", body: { visitIds: picked.map((x) => x.id), ...body } });
    setBulkOpen(false);
    done(`${label} ${r.done}.${r.kept ? ` ${r.kept} couldn't be (already done or invoiced).` : ""}`);
  });
  const saveView = (name: string, shared: boolean) => act.run(async () => {
    const v = await api<{ id: string; name: string; shared: boolean }>("/waitlist/views", { method: "POST", body: { page: "waitlist", name, shared, config: { filters: view.filters, columns: view.columns, sort: view.sort } } });
    setView({ ...view, id: v.id, name: v.name, shared: v.shared, mine: true });
    setSaveOpen(false);
    views.reload();
  });
  const deleteView = (id: string) => act.run(async () => { await api(`/waitlist/views/${id}`, { method: "DELETE" }); views.reload(); });

  return (
    <>
      <PageHead title="Waiting list" sub={d ? `${all.length} waiting${d.requireCard ? " · card on file required" : ""}` : "Loading…"}>
        <Popover open={legendOpen} setOpen={setLegendOpen} label="Badges" align="right" className="cl-pop-wide">
          <div className="wl-legend-list">{badgeLegend()}</div>
        </Popover>
        <Link className="btn" href="/visits/new">New work order</Link>
      </PageHead>
      <ErrorBox error={data.error} />
      {notice && <div className="alert ok row" style={{ justifyContent: "space-between" }}><span>{notice}</span><button type="button" className="linkbtn" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <div className="wl-toolbar">
        <BoardPicker here="waitlist" view={view} builtIn={BUILT_IN_WAIT_VIEWS} saved={views.data} defaults={DEFAULT_WL_COLUMNS} isAdmin={isAdmin}
          onPick={(v) => { setView(v); setQ(v.filters.find((f) => f.key === "q")?.value ?? ""); }} onDelete={deleteView} />
        <input type="search" className="wl-search" placeholder="Search customer, address, service, WO-…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the waiting list" />
        <AddFilter rows={all} crews={crews} tags={tags} onAdd={(fs: Filter[]) => setView({ ...view, filters: [...view.filters, ...fs.filter((f) => !view.filters.some((x) => x.key === f.key && x.value === f.value))] })} />
        {!upcoming && <button type="button" className="btn" onClick={() => setView({ ...view, filters: [...view.filters, { key: "upcoming", value: "1" }] })} title="Also show work orders whose release date hasn't come yet">Include not released yet</button>}
        <SaveView open={saveOpen} setOpen={setSaveOpen} onSave={saveView} busy={act.busy} />
        <span style={{ marginLeft: "auto" }} />
        <button type="button" className="btn" onClick={() => exportCsv(picked.length ? picked : shown, view.columns, crews)} disabled={!shown.length}><Icon name="download" size={14} /> Export{picked.length ? ` ${picked.length}` : ""}</button>
      </div>
      {view.filters.length > 0 && (
        <div className="cl-chips" aria-label="Filters in use" style={{ marginBottom: 10 }}>
          {view.filters.map((f, i) => (
            <span key={`${f.key}-${f.value}-${i}`} className="cl-chip">
              <span className="cl-chip-text">{describeFilter(f, { services, crews, tags: tagNames })}</span>
              <button type="button" className="cl-chip-x" aria-label="Remove this filter" onClick={() => removeFilter(i)}>✕</button>
            </span>
          ))}
          {view.filters.length > 1 && <button type="button" className="linkbtn" onClick={() => { setQ(""); setView({ ...view, filters: [] }); }}>Clear all</button>}
        </div>
      )}

      {d && (
        <div className="stack wl-page">
          <WaitMap rows={shown} colors={colors} selected={selected} onToggle={toggle} onSelect={(ids) => setSelected(new Set([...selected, ...ids]))} fitKey={fitKey} unmapped={shown.filter((r) => r.property.lat == null).length} />
          <WorkloadStrip today={d.today} reloadKey={workKey} selectedMinutes={pickedTotals.minutes} onPick={(date, crewId) => { if (picked.length) setEdit({ date, crewId }); else setNotice("Select work orders on the map or the list first, then click a day to schedule them into it."); }} />
          <div className="card cl-table-card">
            <div className="cl-bulk wl-bulk">
              {picked.length ? (
                <>
                  <strong>{picked.length} selected</strong>
                  <span className="muted">{hours(pickedTotals.minutes)} h · {Math.round(pickedTotals.sqFt).toLocaleString()} sq ft · {formatMoney(pickedTotals.cents)}</span>
                  <SelectionBreakdown rows={picked} crews={crews} />
                  <button type="button" className="btn primary" onClick={() => setEdit({})}>Edit work orders</button>
                  <Popover open={bulkOpen} setOpen={setBulkOpen} label="More ▾">
                    <BulkMenu busy={act.busy} isAdmin={isAdmin} onPriority={(p) => bulk({ action: "priority", priority: p }, `Set the priority on`)} onSkip={(reason) => bulk({ action: "skip", reason }, "Skipped")}
                      onDelete={() => { if (confirm(`Delete ${picked.length} work order${picked.length === 1 ? "" : "s"}? This can't be undone.`)) bulk({ action: "delete" }, "Deleted"); }} />
                  </Popover>
                  <button type="button" className="linkbtn" onClick={() => setSelected(new Set())}>Clear selection</button>
                </>
              ) : (
                <span className="muted">Select work orders here or on the map (click pins, or Draw a box), then Edit work orders to schedule them.</span>
              )}
              <span style={{ marginLeft: "auto" }} />
              <Columns shown={view.columns.length ? view.columns : DEFAULT_WL_COLUMNS} onChange={(columns) => setView({ ...view, columns })} />
            </div>
            <ErrorBox error={act.error} />
            {shown.length ? (
              <WaitTable rows={shown} crews={crews} columns={view.columns.length ? view.columns : DEFAULT_WL_COLUMNS} sort={view.sort} onSort={onSort}
                selected={selected} setSelected={setSelected} limit={limit} onMore={() => setLimit(limit + 300)} />
            ) : (
              <Empty>{all.length ? "Nothing matches these filters." : <>Nothing is waiting. Work orders with no date land here: make one <Link href="/visits/new">On the waitlist</Link>, or take the date off one.</>}</Empty>
            )}
          </div>
        </div>
      )}
      {edit && d && (
        <EditWorkOrders rows={picked} crews={crews} today={d.today} initial={edit} onClose={() => setEdit(null)} onDone={done} />
      )}
    </>
  );
}
