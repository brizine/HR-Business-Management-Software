"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { formatMinutes, todoState } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { DispatcherNotes, TodoForm, WorkTracking, todoPeople, todoWhen, todosChanged, type Todo } from "@/components/todos";
import { VisitFiles } from "@/components/visit-files";

type Detail = Todo & { seriesLeft: number; seriesEnd: string | null; today: string };

/**
 * A to-do's job sheet (Homeworks' "Work Order" view of a to-do): what, where, who and the notes in
 * one printable table; work tracking (Start work / Stop / Done); notes for the dispatcher; photos
 * and documents. Edit opens the form with Delete and Complete, as in Homeworks.
 */
export default function TodoSheet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { me, can } = useAuth();
  const data = useApi<Detail>(`/todos/${id}`);
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const t = data.data;
  if (data.error) return <><PageHead title="To-do" /><ErrorBox error={data.error} /></>;
  if (!t) return <PageHead title="To-do" sub="Loading…" />;
  const manager = can("manager", "todos");
  const mine = t.assignees.some((a) => a.id === me?.user.id);
  const canEdit = manager || t.createdById === me?.user.id;
  const canWork = canEdit || mine;
  const state = todoState(t, t.today);
  const update = (next: Todo) => data.setData({ ...t, ...next });
  const back = () => (window.history.length > 1 ? router.back() : router.push("/todos"));
  const remove = (scope: "one" | "following") => act.run(async () => {
    await api(`/todos/${t.id}?scope=${scope}`, { method: "DELETE" });
    todosChanged();
    router.push("/todos");
  });
  const complete = () => act.run(async () => { update(await api<Todo>(`/todos/${t.id}/done`, { method: "POST", body: { done: true } })); todosChanged(); setEditing(false); });
  const mapUrl = t.property ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.property.address)}` : t.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.location)}` : null;
  const propertyNotes = [t.property?.gateCode ? `Gate code ${t.property.gateCode}` : null, t.property?.accessNotes, t.property?.notes].filter(Boolean).join("\n");

  return (
    <>
      <PageHead title={t.title} before={<Link className="btn no-print" href="/todos" aria-label="Back to to-dos">←</Link>}
        sub={<>{t.doneAt ? "Done" : state === "overdue" ? "Overdue" : "Open"} · {todoWhen(t)}{t.repeatLabel ? ` · ${t.repeatLabel}` : ""}</>}>
        {editing && canEdit && (
          <>
            <button className="btn danger" disabled={act.busy} onClick={() => confirm(t.seriesId ? "Delete just this one?" : "Delete this to-do?") && remove("one")}>Delete</button>
            {t.seriesId && <button className="btn danger" disabled={act.busy} onClick={() => confirm("Delete this one and the later ones that aren't done? The series stops.") && remove("following")}>Delete this and later</button>}
            {!t.doneAt && <button className="btn primary" disabled={act.busy} onClick={complete}>Complete</button>}
          </>
        )}
      </PageHead>
      <ErrorBox error={act.error} />
      {editing ? (
        <TodoForm todo={t} today={t.today} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); data.reload(); }} />
      ) : (
        <div className="jobsheet-grid">
          <div className="jobsheet-side">
          <div className="card stack">
            <div className="jobsheet-bar">
              <div className="row">
                <button className="btn" onClick={() => window.print()}>Print</button>
                {mapUrl && <a className="btn" href={mapUrl} target="_blank" rel="noopener noreferrer">Directions</a>}
                {canEdit && <button className="btn" onClick={() => setEditing(true)}>Edit to-do</button>}
              </div>
              <button className="btn primary" onClick={back}>Return</button>
            </div>
            <table className="jobsheet-table">
              <caption><span className="visit-dot" style={{ background: t.color }} aria-hidden="true" />{t.title}</caption>
              <tbody>
                <tr><th scope="row">Status</th><td className={t.doneAt ? "status-done" : "status-open"}>{t.doneAt ? `Done${t.doneBy ? ` by ${t.doneBy}` : ""}` : state === "overdue" ? "Open (overdue)" : "Open"}</td></tr>
                <tr><th scope="row">When</th><td>{todoWhen(t)}</td></tr>
                <tr><th scope="row">Type</th><td>{t.repeatLabel ? `Recurring · ${t.repeatLabel}${t.seriesLeft > 1 ? ` (${t.seriesLeft - 1} more after this)` : ""}` : "Single"}</td></tr>
                {t.category && <tr><th scope="row">Category</th><td>{t.category.name}</td></tr>}
                {t.customer && <tr><th scope="row">Customer</th><td>{can("manager", "customers") ? <Link href={`/customers/${t.customer.id}`}>{t.customer.name}</Link> : t.customer.name}</td></tr>}
                {t.property && <tr><th scope="row">Property</th><td>{can("manager", "customers") ? <Link href={`/properties/${t.property.id}`}>{t.property.address}</Link> : t.property.address}</td></tr>}
                {(t.location || !t.property) && <tr><th scope="row">Location</th><td>{t.location ?? ""}</td></tr>}
                {t.crew && <tr><th scope="row">Crew</th><td><span className="visit-dot" style={{ background: t.crew.color }} aria-hidden="true" />{t.crew.name}</td></tr>}
                <tr><th scope="row">Employees</th><td>{t.assignees.length ? todoPeople(t) : "Nobody in particular"}</td></tr>
                <tr><th scope="row">Property notes</th><td>{propertyNotes}</td></tr>
                <tr><th scope="row">Visit notes</th><td>{t.notes ?? ""}</td></tr>
                <tr><th scope="row">Notes for dispatcher</th><td>{t.noteCount ? `${t.noteCount} note${t.noteCount === 1 ? "" : "s"} (below)` : ""}</td></tr>
                <tr><th scope="row">Budgeted hours</th><td>{t.budgetedHours != null ? t.budgetedHours.toFixed(2) : ""}</td></tr>
                {(t.trackedMinutes > 0 || t.startedAt) && <tr><th scope="row">Tracked time</th><td>{formatMinutes(t.trackedMinutes)}{t.startedAt && !t.doneAt ? " (running)" : ""}</td></tr>}
                {t.createdBy && <tr><th scope="row">Made by</th><td>{t.createdBy}</td></tr>}
              </tbody>
            </table>
          </div>
          <DispatcherNotes todoId={t.id} canAdd={canWork} canManage={manager} meId={me?.user.id} onCount={(n) => n !== t.noteCount && update({ ...t, noteCount: n })} />
          </div>
          <div className="jobsheet-side">
            <WorkTracking t={t} onChange={update} canWork={canWork} />
            <VisitFiles base={`/todos/${t.id}`} canAdd={canWork} canManage={manager} meId={me?.user.id} />
          </div>
        </div>
      )}
    </>
  );
}
