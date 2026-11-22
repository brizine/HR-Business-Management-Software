"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { customerName, isInactive, todoState } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, useNewForm } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { TodoDetails, TodoForm, TodoItem, dayLabel, type Todo } from "@/components/todos";

const RANGES = [["14", "Next 2 weeks"], ["31", "Next month"], ["92", "Next 3 months"], ["all", "Everything"]] as const;
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Group = { key: string; label: string; items: Todo[] };

/** Overdue, Today, Tomorrow, then each later day (open); or most recently done first. */
function groupTodos(items: Todo[], today: string, done: boolean): Group[] {
  if (!today || !items.length) return [];
  if (done) return [{ key: "done", label: "Done", items }];
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, t: Todo) => {
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(t);
  };
  const tomorrow = plusDays(today, 1);
  for (const t of items) {
    const state = todoState(t, today);
    if (state === "overdue") add("0-overdue", "Overdue", t);
    else if (state === "today") add("1-today", `Today · ${dayLabel(today)}`, t);
    else if (t.date === tomorrow) add("2-tomorrow", `Tomorrow · ${dayLabel(tomorrow)}`, t);
    else add(`3-${t.date}`, dayLabel(t.date), t);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function Todos() {
  const { me, can } = useAuth();
  const manager = can("manager", "todos");
  const params = useSearchParams();
  const asked = params.get("open");
  const [status, setStatus] = useState<"open" | "done">("open");
  const [who, setWho] = useState(manager ? "all" : "mine");
  const [range, setRange] = useState<string>("31");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<{ customer?: { id: string; name: string }; propertyId?: string } | undefined>();
  const [openId, setOpenId] = useState<string | null>(asked);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // From a customer or property page: "Add to-do" there opens this form already linked.
  useNewForm(() => {
    const url = new URL(window.location.href);
    const customerId = url.searchParams.get("customerId");
    const propertyId = url.searchParams.get("propertyId") ?? undefined;
    if (customerId && can("manager", "customers")) {
      api<any>(`/customers/${customerId}`).then((c) => { setPreset({ customer: { id: c.id, name: customerName(c) }, propertyId }); setAdding(true); }, () => setAdding(true));
    } else { setPreset(undefined); setAdding(true); }
  });

  const today0 = useApi<{ today: string }>("/todos?limit=1");
  const today = today0.data?.today ?? "";
  const path = useMemo(() => {
    if (!today) return null;
    const p = new URLSearchParams({ status });
    if (status === "open" && range !== "all") p.set("to", plusDays(today, Number(range)));
    if (status === "done") p.set("limit", "100");
    if (who === "mine") p.set("mine", "true");
    else if (who !== "all") p.set("assigneeId", who);
    if (query.trim()) p.set("q", query.trim());
    return `/todos?${p}`;
  }, [today, status, range, who, query]);
  const list = useApi<{ today: string; items: Todo[]; more: boolean }>(path);
  const staff = useApi<any[]>(manager ? "/employees" : null);
  useEffect(() => {
    const reload = () => list.reload();
    window.addEventListener("crewdesk:todos", reload);
    return () => window.removeEventListener("crewdesk:todos", reload);
  }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened from a notification or search (?open=…): make sure it's in the list, then show it.
  useEffect(() => {
    if (!asked) return;
    setOpenId(asked);
    api<Todo>(`/todos/${asked}`).then((t) => {
      if (t.doneAt) setStatus("done");
      else if (today && t.date > plusDays(today, 31)) setRange("all");
      if (manager) setWho("all");
    }, () => setNotice("That to-do was deleted, or isn't one you can see."));
  }, [asked, today]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (asked && list.data) document.getElementById(`todo-${asked}`)?.scrollIntoView({ block: "center" });
  }, [asked, list.data]);

  const items = list.data?.items ?? [];
  const groups = groupTodos(items, today, status === "done");
  const hours = (ts: Todo[]) => ts.reduce((s, t) => s + (t.budgetedHours ?? 0), 0);
  const replace = (t: Todo) => list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === t.id ? t : x)) } : d));

  return (
    <>
      <PageHead title="To-dos" sub={list.data ? `${items.length}${list.data.more ? "+" : ""} ${status === "done" ? "done" : "open"}${hours(items) ? ` · ${hours(items)} h budgeted` : ""}` : undefined}>
        {!adding && <button className="btn primary" onClick={() => { setPreset(undefined); setAdding(true); }}>Add to-do</button>}
      </PageHead>
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}
      {adding && (
        <TodoForm preset={preset} today={today || undefined} onCancel={() => setAdding(false)}
          onSaved={(t, created) => { setAdding(false); setNotice(created > 1 ? `Added ${created} to-dos, ${dayLabel(t.date)} onward.` : `Added "${t.title}".`); list.reload(); }} />
      )}
      {editing && (
        <TodoForm todo={editing} today={today || undefined} onCancel={() => setEditing(null)}
          onSaved={(t) => { setEditing(null); setOpenId(t.id); list.reload(); }} />
      )}
      <div className="card filters">
        <label>Show
          <select value={status} onChange={(e) => setStatus(e.target.value as "open" | "done")}>
            <option value="open">To do</option>
            <option value="done">Done</option>
          </select>
        </label>
        {manager && (
          <label>For
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="all">Everyone</option>
              <option value="mine">Me</option>
              <option value="none">Nobody assigned</option>
              {(staff.data ?? []).filter((e) => !isInactive(e.status) && e.id !== me?.user.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
        )}
        {status === "open" && (
          <label>Through
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
        <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, notes, location" /></label>
      </div>
      <ErrorBox error={list.error} />
      {list.data && !groups.length && (
        <div className="card"><Empty>{status === "done" ? "Nothing checked off yet." : who === "mine" || !manager ? "Nothing to do. Nice." : "No to-dos."}</Empty></div>
      )}
      {groups.map((g) => (
        <div key={g.key} className={`card todo-group${g.key === "0-overdue" ? " overdue" : ""}`}>
          <h2 className="todo-group-head">{g.label}<span className="muted"> · {g.items.length}{hours(g.items) ? ` · ${hours(g.items)} h` : ""}</span></h2>
          <ul className="todo-list">
            {g.items.map((t) => (
              <TodoItem key={t.id} t={t} today={today} showDate={g.key === "0-overdue" || status === "done"} open={openId === t.id}
                onOpen={() => setOpenId(openId === t.id ? null : t.id)} onChange={replace}>
                {openId === t.id && <TodoDetails t={t} onEdit={() => { setEditing(t); setOpenId(null); window.scrollTo({ top: 0, behavior: "smooth" }); }} onDeleted={() => { setOpenId(null); list.reload(); }} />}
              </TodoItem>
            ))}
          </ul>
        </div>
      ))}
      {list.data?.more && <p className="muted">Showing the first {items.length}. Narrow it down with the filters.</p>}
    </>
  );
}

export default function Page() {
  return <Suspense><Todos /></Suspense>;
}
