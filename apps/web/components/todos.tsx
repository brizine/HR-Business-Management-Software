"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_TODO_COLOR, TODO_COLORS, TODO_REPEATS, TODO_REPEAT_LABELS, formatAddress, formatTodoTime, isInactive, todoState,
  type TodoRepeat,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { CustomerPicker } from "./customers";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

export interface Todo {
  id: string; title: string; notes: string | null; color: string;
  date: string; endDate: string | null; startTime: string | null; endTime: string | null; budgetedHours: number | null;
  customerId: string | null; propertyId: string | null; location: string | null;
  seriesId: string | null; repeat: string; doneAt: string | null; createdById: string | null;
  customer: { id: string; name: string } | null;
  property: { id: string; name: string | null; address: string; gateCode: string | null } | null;
  assignees: { id: string; firstName: string; lastName: string }[];
  doneBy: string | null; createdBy: string | null;
}

/** Tells the top bar's to-do count (and any open to-do lists) that something changed. */
export const todosChanged = () => window.dispatchEvent(new Event("crewdesk:todos"));

const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/** "Mon, Nov 23 · 8:00 AM – 9:30 AM", "Mon, Nov 23 – Wed, Nov 25". */
export function todoWhen(t: Pick<Todo, "date" | "endDate" | "startTime" | "endTime">) {
  const days = t.endDate && t.endDate !== t.date ? `${dayLabel(t.date)} – ${dayLabel(t.endDate)}` : dayLabel(t.date);
  return [days, formatTodoTime(t.startTime, t.endTime)].filter(Boolean).join(" · ");
}
const placeOf = (t: Todo) => t.property?.address ?? t.location;
const people = (t: Todo) => t.assignees.map((a) => `${a.firstName} ${a.lastName}`).join(", ");

/** The checkbox that ticks a to-do off (or back on). */
export function DoneBox({ t, onChange }: { t: Todo; onChange: (t: Todo) => void }) {
  // Ticks at once; goes back if saving fails.
  const [on, setOn] = useState(!!t.doneAt);
  useEffect(() => { setOn(!!t.doneAt); }, [t.doneAt]);
  return (
    <input type="checkbox" className="todo-check" checked={on} aria-label={on ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        const done = e.target.checked;
        setOn(done);
        try { onChange(await api<Todo>(`/todos/${t.id}/done`, { method: "POST", body: { done } })); todosChanged(); } catch (err) { setOn(!done); alert((err as Error).message); }
      }} />
  );
}

/** One to-do in a list: color, checkbox, title, then when / where / who. */
export function TodoItem({ t, today, onChange, onOpen, open, showDate, extra, children }: {
  t: Todo; today: string; onChange: (t: Todo) => void; onOpen?: () => void; open?: boolean; showDate?: boolean; extra?: string; children?: ReactNode;
}) {
  const state = todoState(t, today);
  const time = showDate ? todoWhen(t) : [t.endDate && t.endDate !== t.date ? `${dayLabel(t.date)} – ${dayLabel(t.endDate)}` : null, formatTodoTime(t.startTime, t.endTime)].filter(Boolean).join(" · ");
  const meta = [
    time || null,
    t.customer?.name, placeOf(t),
    t.assignees.length ? people(t) : "Nobody assigned",
    t.budgetedHours ? `${t.budgetedHours} h` : null,
    extra,
  ].filter(Boolean).join(" · ");
  return (
    <li id={`todo-${t.id}`} className={`todo-item${t.doneAt ? " done" : ""}${open ? " open" : ""}`} style={{ borderLeftColor: t.color }}>
      <div className="todo-line" onClick={onOpen} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined}
        onKeyDown={(e) => { if (onOpen && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }} aria-expanded={onOpen ? !!open : undefined}>
        <DoneBox t={t} onChange={onChange} />
        <div className="todo-text">
          <div className="todo-title">
            {t.title}
            {t.seriesId && <span className="todo-repeat" title={TODO_REPEAT_LABELS[t.repeat as TodoRepeat] ?? "Repeats"}>↻</span>}
            {state === "overdue" && <span className="badge bad">overdue</span>}
          </div>
          <div className="muted todo-meta">{meta}</div>
        </div>
      </div>
      {children}
    </li>
  );
}

/** The details under an opened to-do: notes, gate code, who made it, and Edit / Delete. */
export function TodoDetails({ t, onEdit, onDeleted }: { t: Todo; onEdit: () => void; onDeleted: () => void }) {
  const { me, can } = useAuth();
  const del = useAction();
  const canEdit = can("manager", "todos") || t.createdById === me?.user.id;
  const remove = (scope: "one" | "following") => del.run(async () => {
    const r = await api<{ deleted: number }>(`/todos/${t.id}?scope=${scope}`, { method: "DELETE" });
    todosChanged();
    onDeleted();
    return r;
  });
  return (
    <div className="todo-details">
      {t.notes && <p className="todo-notes">{t.notes}</p>}
      <dl className="facts">
        {t.customer && <><dt>Customer</dt><dd>{can("manager", "customers") ? <Link href={`/customers/${t.customer.id}`}>{t.customer.name}</Link> : t.customer.name}</dd></>}
        {t.property && <><dt>Property</dt><dd>{can("manager", "customers") ? <Link href={`/properties/${t.property.id}`}>{t.property.address}</Link> : t.property.address}{t.property.gateCode ? ` · gate code ${t.property.gateCode}` : ""}</dd></>}
        {!t.property && t.location && <><dt>Location</dt><dd>{t.location}</dd></>}
        <dt>When</dt><dd>{todoWhen(t)}{t.seriesId ? ` · ${(TODO_REPEAT_LABELS[t.repeat as TodoRepeat] ?? "repeats").toLowerCase()}` : ""}</dd>
        <dt>For</dt><dd>{t.assignees.length ? people(t) : "Nobody in particular"}</dd>
        {t.budgetedHours != null && <><dt>Budgeted</dt><dd>{t.budgetedHours} hours</dd></>}
        {t.createdBy && <><dt>Made by</dt><dd>{t.createdBy}</dd></>}
        {t.doneAt && <><dt>Done</dt><dd>{new Date(t.doneAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{t.doneBy ? ` by ${t.doneBy}` : ""}</dd></>}
      </dl>
      {canEdit && (
        <div className="row">
          <button type="button" className="btn" onClick={onEdit}>Edit</button>
          {t.seriesId ? (
            <>
              <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete just this one?") && remove("one")}>Delete this one</button>
              <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete this one and the later ones that aren't done?") && remove("following")}>Delete this and later</button>
            </>
          ) : <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete this to-do?") && remove("one")}>Delete</button>}
        </div>
      )}
      <ErrorBox error={del.error} />
    </div>
  );
}

/**
 * Add or change a to-do, laid out like Homeworks': what it is; customer, property, color and location;
 * scheduling (single or repeating, date, more than one day, time, budgeted hours); who it's for; notes.
 */
export function TodoForm({ todo, preset, today, onSaved, onCancel }: {
  todo?: Todo; preset?: { customer?: { id: string; name: string }; propertyId?: string; date?: string };
  today?: string; onSaved: (t: Todo, created: number) => void; onCancel: () => void;
}) {
  const { me, can } = useAuth();
  const manager = can("manager", "todos");
  const canCustomers = can("manager", "customers");
  const start = todo?.date ?? preset?.date ?? today ?? localToday();
  const [title, setTitle] = useState(todo?.title ?? "");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(todo?.customer ?? preset?.customer ?? null);
  const [propertyId, setPropertyId] = useState(todo?.propertyId ?? preset?.propertyId ?? "");
  const [location, setLocation] = useState(todo?.location ?? "");
  const [color, setColor] = useState(todo?.color ?? DEFAULT_TODO_COLOR);
  const [repeat, setRepeat] = useState<TodoRepeat>("none");
  const [until, setUntil] = useState("");
  const [date, setDate] = useState(start);
  const [multi, setMulti] = useState(!!todo?.endDate);
  const [endDate, setEndDate] = useState(todo?.endDate ?? plusDays(start, 1));
  const [timed, setTimed] = useState(!!todo?.startTime);
  const [startTime, setStartTime] = useState(todo?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(todo?.endTime ?? "");
  const [hours, setHours] = useState(todo?.budgetedHours != null ? String(todo.budgetedHours) : "");
  const [assignees, setAssignees] = useState<string[]>(todo ? todo.assignees.map((a) => a.id) : manager || !me ? [] : [me.user.id]);
  const [notes, setNotes] = useState(todo?.notes ?? "");
  const [applyTo, setApplyTo] = useState<"one" | "following">("one");
  const save = useAction();
  const detail = useApi<any>(customer && canCustomers ? `/customers/${customer.id}` : null);
  const staff = useApi<any[]>(manager ? "/employees" : null);
  const properties: { id: string; address: string }[] = (detail.data?.properties ?? []).map((p: any) => ({ id: p.id, address: [p.name, formatAddress(p)].filter(Boolean).join(" · ") }));
  // A customer with a single property: pick it.
  useEffect(() => { if (properties.length === 1 && !propertyId && !todo) setPropertyId(properties[0].id); }, [properties.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const team = (staff.data ?? []).filter((e) => !isInactive(e.status) || assignees.includes(e.id));
  const toggle = (id: string) => setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      const body = {
        title, notes, location, color, date,
        customerId: customer?.id ?? null, propertyId: customer ? propertyId || null : null,
        endDate: multi && repeat === "none" ? endDate : null,
        startTime: timed ? startTime : null, endTime: timed ? endTime || null : null,
        budgetedHours: hours.trim() === "" ? null : Number(hours),
        assigneeIds: assignees,
        ...(todo ? {} : { repeat, repeatUntil: repeat === "none" ? null : until }),
      };
      const r = todo
        ? await api<Todo & { changed: number }>(`/todos/${todo.id}${todo.seriesId && applyTo === "following" ? "?applyTo=following" : ""}`, { method: "PUT", body })
        : await api<Todo & { created: number }>("/todos", { method: "POST", body });
      todosChanged();
      onSaved(r, "created" in r ? r.created : 1);
    });
  };

  return (
    <form className="card stack todo-form" onSubmit={submit}>
      <h2>{todo ? "Edit to-do" : "New to-do"}</h2>
      <label>To-do title or description *<input required autoFocus maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call the HOA about the gate code" /></label>

      <h3 className="todo-section">Customer</h3>
      <div className="formgrid">
        {customer ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="todo-label">Customer</span>
            <div className="row"><strong>{customer.name}</strong>
              {canCustomers && <button type="button" className="linkbtn" onClick={() => { setCustomer(null); setPropertyId(""); }}>Change</button>}
            </div>
          </div>
        ) : canCustomers ? <CustomerPicker label="Customer (optional)" onPick={(c) => { setCustomer({ id: c.id, name: c.name }); setPropertyId(""); }} />
          : <p className="muted" style={{ margin: 0 }}>Linking a customer needs Customers &amp; billing access.</p>}
        {customer && canCustomers && (
          <label>Property
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">No property</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
            </select>
          </label>
        )}
        {customer && !canCustomers && todo?.property && <div className="stack" style={{ gap: 4 }}><span className="todo-label">Property</span><span>{todo.property.address}</span></div>}
        <label>Location {propertyId ? "(the property's address is used)" : "(optional)"}<input maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Shop, supplier, an address…" /></label>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="todo-label">Color</span>
        <div className="todo-colors" role="radiogroup" aria-label="Color">
          {TODO_COLORS.map((c) => (
            <button key={c.key} type="button" role="radio" aria-checked={color.toLowerCase() === c.key} aria-label={c.label} title={c.label}
              style={{ background: c.key }} onClick={() => setColor(c.key)} />
          ))}
        </div>
      </div>

      <h3 className="todo-section">Scheduling</h3>
      <div className="formgrid">
        {!todo && (
          <label>Repeats
            <select value={repeat} onChange={(e) => { const r = e.target.value as TodoRepeat; setRepeat(r); if (r !== "none" && !until) setUntil(plusDays(date, 90)); }}>
              {TODO_REPEATS.map((r) => <option key={r} value={r}>{TODO_REPEAT_LABELS[r]}</option>)}
            </select>
          </label>
        )}
        <label>{repeat === "none" ? (multi ? "First day" : "Date") : "First date"}<input type="date" required value={date} onChange={(e) => { setDate(e.target.value); if (endDate <= e.target.value) setEndDate(plusDays(e.target.value, 1)); }} /></label>
        {repeat !== "none" && <label>Repeat until<input type="date" required min={date} max={plusDays(date, 366)} value={until} onChange={(e) => setUntil(e.target.value)} /></label>}
        {multi && repeat === "none" && <label>Last day<input type="date" required min={date} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>}
        <label>Budgeted hours<input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0.00" /></label>
      </div>
      <div className="row" style={{ gap: 16 }}>
        {repeat === "none" && <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> More than one day</label>}
        <label className="check"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Set a time</label>
      </div>
      {timed && (
        <div className="formgrid">
          <label>Start time<input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          <label>End time (optional)<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
        </div>
      )}

      <h3 className="todo-section">For</h3>
      {manager ? (
        <div className="todo-people" role="group" aria-label="Who it's for">
          {team.map((e) => (
            <label key={e.id} className="check"><input type="checkbox" checked={assignees.includes(e.id)} onChange={() => toggle(e.id)} /> {e.firstName} {e.lastName}{e.title ? <span className="muted"> · {e.title}</span> : null}</label>
          ))}
          {!assignees.length && <p className="muted" style={{ margin: 0, gridColumn: "1 / -1" }}>Nobody picked: it shows on the To-dos page for managers.</p>}
        </div>
      ) : <p className="muted" style={{ margin: 0 }}>{todo && todo.assignees.length ? people(todo) : "You."} A manager can give to-dos to others.</p>}

      <label>Notes (optional)<textarea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {todo?.seriesId && (
        <div className="row" style={{ gap: 16 }}>
          <label className="check"><input type="radio" checked={applyTo === "one"} onChange={() => setApplyTo("one")} /> Change just this one</label>
          <label className="check"><input type="radio" checked={applyTo === "following"} onChange={() => setApplyTo("following")} /> This one and the later ones that aren&apos;t done</label>
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : todo ? "Save" : repeat === "none" ? "Add to-do" : "Add to-dos"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Customer and property pages: their open to-dos (and recently done ones), with Add to-do. */
export function LinkedTodos({ customerId, propertyId, customer }: { customerId?: string; propertyId?: string; customer?: { id: string; name: string } | null }) {
  const query = customerId ? `customerId=${customerId}` : `propertyId=${propertyId}`;
  const open = useApi<{ today: string; items: Todo[] }>(`/todos?${query}`);
  const done = useApi<{ today: string; items: Todo[] }>(`/todos?${query}&status=done&limit=5`);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Todo | null>(null);
  useEffect(() => {
    const reload = () => { open.reload(); done.reload(); };
    window.addEventListener("crewdesk:todos", reload);
    return () => window.removeEventListener("crewdesk:todos", reload);
  }, [open.reload, done.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = open.data?.today ?? localToday();
  // A repeating to-do shows once: its next open one, with how many more are coming.
  const later = new Map<string, number>();
  const openItems = (open.data?.items ?? []).filter((t) => {
    if (!t.seriesId) return true;
    later.set(t.seriesId, (later.get(t.seriesId) ?? -1) + 1);
    return later.get(t.seriesId) === 0;
  });
  const items = [...openItems, ...(done.data?.items ?? [])];
  const more = (t: Todo) => (t.seriesId && !t.doneAt && later.get(t.seriesId) ? `${later.get(t.seriesId)} more coming` : undefined);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>To-dos{open.data?.items.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {open.data.items.length} open</span> : null}</h2>
        {!adding && <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add to-do</button>}
      </div>
      {adding && <div style={{ marginTop: 12 }}><TodoForm preset={{ customer: customer ?? undefined, propertyId: customer ? propertyId : undefined }} today={today} onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} /></div>}
      {editing && <div style={{ marginTop: 12 }}><TodoForm todo={editing} today={today} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} /></div>}
      {items.length ? (
        <ul className="todo-list">
          {items.map((t) => (
            <TodoItem key={t.id} t={t} today={today} showDate extra={more(t)} open={openId === t.id} onOpen={() => setOpenId(openId === t.id ? null : t.id)} onChange={() => todosChanged()}>
              {openId === t.id && <TodoDetails t={t} onEdit={() => { setEditing(t); setOpenId(null); }} onDeleted={() => setOpenId(null)} />}
            </TodoItem>
          ))}
        </ul>
      ) : open.data && !adding ? <p className="muted" style={{ margin: "8px 0 0" }}>No to-dos{customerId ? " for this customer" : " here"}.</p> : null}
    </div>
  );
}

