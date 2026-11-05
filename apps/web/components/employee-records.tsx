"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DISCIPLINE_REASONS,
  DISCIPLINE_REASON_LABELS,
  DISCIPLINE_TYPES,
  DISCIPLINE_TYPE_LABELS,
  RATING_LABELS,
  REVIEW_TYPES,
  REVIEW_TYPE_LABELS,
  hasRole,
  isInactive,
  recordTypeLabel,
  roleInArea,
  type RecordKind,
  type Role,
} from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

export type EmployeeRecord = {
  id: string; employeeId: string; authorId: string | null; authorName: string | null; kind: RecordKind; type: string; date: string;
  periodStart: string | null; periodEnd: string | null; rating: number | null; strengths: string | null; improvements: string | null; goals: string | null;
  reason: string | null; incidentDate: string | null; expectations: string | null; followUpDate: string | null; summary: string;
  status: "draft" | "shared" | "acknowledged"; sharedAt: string | null; acknowledgedAt: string | null; employeeComment: string | null;
  employee: { id: string; firstName: string; lastName: string; title: string | null };
};

const STATUS_TEXT = { draft: "Draft (only managers see it)", shared: "Shared: waiting for acknowledgement", acknowledged: "Acknowledged" } as const;
const STATUS_TONE = { draft: "", shared: "warn", acknowledged: "ok" } as const;
const SERIOUS = new Set(["final_warning", "suspension", "termination"]);
const name = (r: EmployeeRecord) => `${r.employee.firstName} ${r.employee.lastName}`;

export function StatusBadge({ status }: { status: EmployeeRecord["status"] }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{status === "draft" ? "draft" : status === "shared" ? "waiting for acknowledgement" : "acknowledged"}</span>;
}

export function KindBadge({ r }: { r: Pick<EmployeeRecord, "kind" | "type"> }) {
  return <span className={`badge ${r.kind === "review" ? "" : SERIOUS.has(r.type) ? "bad" : "warn"}`}>{recordTypeLabel(r.kind, r.type)}</span>;
}

/** Can the signed-in person edit / share / delete this record? (The API checks too.) */
function useCanChange() {
  const { me, can } = useAuth();
  return (r: EmployeeRecord) => r.employeeId !== me?.user.id && (can("admin", "reviews") || (r.status === "draft" && r.authorId === me?.user.id && can("manager", "reviews")));
}

/** Opens a printable copy (for a signed paper file). */
function printRecord(r: EmployeeRecord, company: string) {
  const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const row = (label: string, value: string | null | undefined) => (value ? `<tr><th>${esc(label)}</th><td>${esc(value).replace(/\n/g, "<br>")}</td></tr>` : "");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(recordTypeLabel(r.kind, r.type))} – ${esc(name(r))}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:40px;color:#111}h1{font-size:20px;margin:0}h2{font-size:14px;color:#555;margin:2px 0 20px;font-weight:400}
table{border-collapse:collapse;width:100%}th{text-align:left;vertical-align:top;width:180px;padding:8px 12px 8px 0;color:#444}td{padding:8px 0;border-bottom:1px solid #ddd}
.sign{display:flex;gap:40px;margin-top:48px}.sign div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:12px;color:#444}</style></head><body>
<h1>${esc(recordTypeLabel(r.kind, r.type))}</h1><h2>${esc(company)} · ${esc(name(r))}${r.employee.title ? ` (${esc(r.employee.title)})` : ""}</h2><table>
${row("Date", fmtDate(r.date))}${row("Written by", r.authorName)}
${r.kind === "review" ? row("Review period", r.periodStart || r.periodEnd ? `${r.periodStart ? fmtDate(r.periodStart) : "…"} – ${r.periodEnd ? fmtDate(r.periodEnd) : "…"}` : null) + row("Overall rating", r.rating ? `${r.rating} of 5: ${RATING_LABELS[r.rating]}` : null) + row("Summary", r.summary) + row("Strengths", r.strengths) + row("Areas to improve", r.improvements) + row("Goals", r.goals)
    : row("Reason", r.reason ? (DISCIPLINE_REASON_LABELS as Record<string, string>)[r.reason] : null) + row("Incident date", r.incidentDate ? fmtDate(r.incidentDate) : null) + row("What happened", r.summary) + row("Expectations and next steps", r.expectations) + row("Follow-up date", r.followUpDate ? fmtDate(r.followUpDate) : null)}
${row("Acknowledged", r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleString() : null)}${row("Employee's comment", r.employeeComment)}
</table><div class="sign"><div>Employee signature / date</div><div>Manager signature / date</div></div>
<p style="font-size:12px;color:#666;margin-top:24px">Signing acknowledges receipt, not necessarily agreement.</p></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return alert("Allow pop-ups for this site to print.");
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** New or edit form for a review or disciplinary action. */
export function RecordForm({ kind, record, employeeId, onSaved, onCancel }: { kind: RecordKind; record?: EmployeeRecord; employeeId?: string; onSaved: (r: EmployeeRecord) => void; onCancel: () => void }) {
  const { me } = useAuth();
  const staff = useApi<any[]>("/employees");
  const { busy, error, run } = useAction();
  const [rating, setRating] = useState<number | null>(record?.rating ?? null);
  // People this person can write up: active, not themselves, below their level here (owners: anyone else).
  const mine: Role = me?.user.role === "owner" ? "owner" : roleInArea(me!.user.role, me?.access?.areas, "reviews");
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status) && e.id !== me?.user.id && (mine === "owner" || !hasRole(e.role, mine)));
  const v = record ?? ({} as Partial<EmployeeRecord>);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form className="card stack record-form" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const s = (k: string) => ((f.get(k) as string) ?? "").trim();
      const body = kind === "review"
        ? { kind, employeeId: record?.employeeId ?? s("employeeId"), type: s("type"), date: s("date"), periodStart: s("periodStart") || null, periodEnd: s("periodEnd") || null, rating, summary: s("summary"), strengths: s("strengths"), improvements: s("improvements"), goals: s("goals") }
        : { kind, employeeId: record?.employeeId ?? s("employeeId"), type: s("type"), date: s("date"), reason: s("reason"), incidentDate: s("incidentDate") || null, summary: s("summary"), expectations: s("expectations"), followUpDate: s("followUpDate") || null };
      run(async () => onSaved(await api<EmployeeRecord>(record ? `/reviews/${record.id}` : "/reviews", { method: record ? "PUT" : "POST", body })));
    }}>
      <h2 style={{ margin: 0 }}>{record ? "Edit" : "New"} {kind === "review" ? "performance review" : "disciplinary action"}</h2>
      <div className="formgrid">
        <label>Employee
          {record ? <input value={name(record)} disabled /> : (
            <select name="employeeId" required defaultValue={employeeId ?? ""}>
              <option value="" disabled>Choose…</option>
              {people.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}{e.title ? ` · ${e.title}` : ""}</option>)}
            </select>
          )}
        </label>
        <label>{kind === "review" ? "Review type" : "Action"}
          <select name="type" required defaultValue={v.type ?? (kind === "review" ? "annual" : "verbal_warning")}>
            {kind === "review"
              ? REVIEW_TYPES.map((t) => <option key={t} value={t}>{REVIEW_TYPE_LABELS[t]}</option>)
              : DISCIPLINE_TYPES.map((t) => <option key={t} value={t}>{DISCIPLINE_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label>Date<input type="date" name="date" required defaultValue={v.date ?? today} /></label>
        {kind === "review" ? (
          <>
            <label>Period from<input type="date" name="periodStart" defaultValue={v.periodStart ?? ""} /></label>
            <label>Period to<input type="date" name="periodEnd" defaultValue={v.periodEnd ?? ""} /></label>
          </>
        ) : (
          <>
            <label>Reason
              <select name="reason" required defaultValue={v.reason ?? "attendance"}>
                {DISCIPLINE_REASONS.map((t) => <option key={t} value={t}>{DISCIPLINE_REASON_LABELS[t]}</option>)}
              </select>
            </label>
            <label>When it happened<input type="date" name="incidentDate" defaultValue={v.incidentDate ?? ""} /></label>
            <label>Follow-up date<input type="date" name="followUpDate" defaultValue={v.followUpDate ?? ""} /></label>
          </>
        )}
      </div>
      {kind === "review" && (
        <fieldset className="contact-fieldset">
          <legend>Overall rating</legend>
          <div className="rating-picker" role="radiogroup" aria-label="Overall rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={rating === n} className={`btn sm ${rating === n ? "primary" : ""}`} onClick={() => setRating(rating === n ? null : n)}>
                {n} · {RATING_LABELS[n]}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <label>{kind === "review" ? "Summary" : "What happened"}<textarea name="summary" required rows={4} defaultValue={v.summary ?? ""} placeholder={kind === "review" ? "Overall, how did they do?" : "Facts: what happened, when, where, who was involved."} /></label>
      {kind === "review" ? (
        <>
          <label>Strengths<textarea name="strengths" rows={3} defaultValue={v.strengths ?? ""} /></label>
          <label>Areas to improve<textarea name="improvements" rows={3} defaultValue={v.improvements ?? ""} /></label>
          <label>Goals for the next period<textarea name="goals" rows={3} defaultValue={v.goals ?? ""} /></label>
        </>
      ) : (
        <label>Expectations and next steps<textarea name="expectations" rows={3} defaultValue={v.expectations ?? ""} placeholder="What needs to change, any support offered, and what happens if it continues." /></label>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Saved as a draft only managers can see. Share it when you&apos;re ready; the employee is notified and asked to acknowledge it.</p>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{record ? "Save changes" : "Save draft"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** One record in full, with what this person can do with it. */
export function RecordDetail({ r, onChange, onDeleted }: { r: EmployeeRecord; onChange: (r: EmployeeRecord) => void; onDeleted: () => void }) {
  const { me } = useAuth();
  const canChange = useCanChange();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const { busy, error, run } = useAction();
  const mine = r.employeeId === me?.user.id;
  if (editing) return <RecordForm kind={r.kind} record={r} onCancel={() => setEditing(false)} onSaved={(x) => { setEditing(false); onChange(x); }} />;
  const block = (label: string, value: string | null | undefined) => value ? <div><div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{label}</div><div style={{ whiteSpace: "pre-wrap" }}>{value}</div></div> : null;

  return (
    <div className="stack record-detail">
      <div className="row" style={{ gap: 8 }}>
        <KindBadge r={r} /><StatusBadge status={r.status} />
        {r.rating && <span className="badge">{r.rating}/5 · {RATING_LABELS[r.rating]}</span>}
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {fmtDate(r.date)}{r.authorName ? ` · by ${r.authorName}` : ""}
        {r.kind === "review" && (r.periodStart || r.periodEnd) && ` · period ${r.periodStart ? fmtDate(r.periodStart) : "…"} – ${r.periodEnd ? fmtDate(r.periodEnd) : "…"}`}
        {r.kind === "discipline" && r.reason && ` · ${(DISCIPLINE_REASON_LABELS as Record<string, string>)[r.reason]}`}
        {r.incidentDate && ` · happened ${fmtDate(r.incidentDate)}`}
        {r.followUpDate && ` · follow up ${fmtDate(r.followUpDate)}`}
      </div>
      {block(r.kind === "review" ? "Summary" : "What happened", r.summary)}
      {block("Strengths", r.strengths)}
      {block("Areas to improve", r.improvements)}
      {block("Goals", r.goals)}
      {block("Expectations and next steps", r.expectations)}
      {r.acknowledgedAt && block(`Acknowledged ${new Date(r.acknowledgedAt).toLocaleString()}${r.employeeComment ? ", with this comment" : ""}`, r.employeeComment ?? " ")}
      <ErrorBox error={error} />
      {mine && r.status === "shared" && (
        <div className="card stack" style={{ margin: 0 }}>
          <strong>Please acknowledge</strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>This confirms you&apos;ve read it. It doesn&apos;t mean you agree; you can add your side below.</p>
          <label>Your comment (optional)<textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} /></label>
          <div><button className="btn primary" disabled={busy} onClick={() => run(async () => onChange(await api(`/reviews/${r.id}/acknowledge`, { body: { comment: comment || undefined } })))}>I&apos;ve read this</button></div>
        </div>
      )}
      <div className="row">
        {canChange(r) && r.status === "draft" && (
          <button className="btn primary" disabled={busy} onClick={() => confirm(`Share this with ${r.employee.firstName}? They'll be notified and asked to acknowledge it.`) && run(async () => onChange(await api(`/reviews/${r.id}/share`, { method: "POST" })))}>
            Share with {r.employee.firstName}
          </button>
        )}
        {canChange(r) && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        <button className="btn" onClick={() => printRecord(r, me?.company.name ?? "")}>Print</button>
        {canChange(r) && <button className="btn danger" disabled={busy} onClick={() => confirm("Delete this record? This can't be undone.") && run(async () => { await api(`/reviews/${r.id}`, { method: "DELETE" }); onDeleted(); })}>Delete</button>}
      </div>
    </div>
  );
}

const NO_FILTERS = { q: "", kind: "", type: "", status: "", person: "" };

/**
 * Reviews and disciplinary actions: everyone's for managers (or one person's, with `employeeId`);
 * your own shared ones otherwise. `filterable` adds search and filters.
 */
export function RecordList({ employeeId, filterable = false, openId, compact = false, newKind, onNewDone }: {
  employeeId?: string; filterable?: boolean; openId?: string | null; compact?: boolean; newKind?: RecordKind | null; onNewDone?: () => void;
}) {
  const { can } = useAuth();
  const manager = can("manager", "reviews");
  const list = useApi<EmployeeRecord[]>(`/reviews${employeeId ? `?employeeId=${employeeId}` : ""}`);
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const set = (p: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...p }));
  useEffect(() => { if (openId) setOpen(openId); }, [openId]);
  const all = list.data ?? [];
  const q = filters.q.trim().toLowerCase();
  const rows = all.filter((r) =>
    (!q || `${name(r)} ${recordTypeLabel(r.kind, r.type)} ${r.summary} ${r.strengths ?? ""} ${r.improvements ?? ""} ${r.goals ?? ""} ${r.expectations ?? ""} ${r.authorName ?? ""}`.toLowerCase().includes(q)) &&
    (!filters.kind || r.kind === filters.kind) &&
    (!filters.type || r.type === filters.type) &&
    (!filters.status || r.status === filters.status) &&
    (!filters.person || r.employeeId === filters.person));
  const filtering = Object.values(filters).some(Boolean);
  const people = [...new Map(all.map((r) => [r.employeeId, name(r)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const replace = (x: EmployeeRecord) => list.setData(all.map((r) => (r.id === x.id ? x : r)));

  return (
    <>
      {newKind && (
        <RecordForm kind={newKind} employeeId={employeeId} onCancel={() => onNewDone?.()} onSaved={(r) => { list.setData([r, ...all]); setOpen(r.id); onNewDone?.(); }} />
      )}
      {filterable && (
        <form className="card filters" role="search" aria-label="Filter reviews and disciplinary actions" onSubmit={(e) => e.preventDefault()}>
          <label>Search<input type="search" placeholder={manager ? "Name, words in the write-up…" : "Words in the write-up…"} value={filters.q} onChange={(e) => set({ q: e.target.value })} /></label>
          <label>Kind
            <select value={filters.kind} onChange={(e) => set({ kind: e.target.value, type: "" })}>
              <option value="">Reviews and discipline</option>
              <option value="review">Performance reviews</option>
              <option value="discipline">Disciplinary actions</option>
            </select>
          </label>
          <label>Type
            <select value={filters.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">Any</option>
              {filters.kind !== "discipline" && <optgroup label="Reviews">{REVIEW_TYPES.map((t) => <option key={t} value={t}>{REVIEW_TYPE_LABELS[t]}</option>)}</optgroup>}
              {filters.kind !== "review" && <optgroup label="Discipline">{DISCIPLINE_TYPES.map((t) => <option key={t} value={t}>{DISCIPLINE_TYPE_LABELS[t]}</option>)}</optgroup>}
            </select>
          </label>
          <label>Status
            <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Any</option>
              {manager && <option value="draft">Drafts</option>}
              <option value="shared">Waiting for acknowledgement</option>
              <option value="acknowledged">Acknowledged</option>
            </select>
          </label>
          {manager && !employeeId && (
            <label>Employee
              <select value={filters.person} onChange={(e) => set({ person: e.target.value })}>
                <option value="">Everyone</option>
                {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
              </select>
            </label>
          )}
          {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </form>
      )}
      <div className={compact ? "" : "card"}>
        <ErrorBox error={list.error} />
        {rows.length ? (
          <table className="record-table"><tbody>{rows.map((r) => (
            [
              <tr key={r.id} className={open === r.id ? "open" : undefined} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: "pointer" }}>
                <td style={{ width: 110 }}>{fmtDate(r.date)}</td>
                {!employeeId && manager && <td><strong>{name(r)}</strong>{r.employee.title && <div className="muted" style={{ fontSize: 12 }}>{r.employee.title}</div>}</td>}
                <td><KindBadge r={r} />{r.rating ? <span className="muted" style={{ fontSize: 12 }}> · {r.rating}/5</span> : null}</td>
                <td className="muted record-snippet">{r.summary}</td>
                <td style={{ textAlign: "right" }}><StatusBadge status={r.status} /></td>
              </tr>,
              open === r.id && (
                <tr key={`${r.id}-open`} className="record-open"><td colSpan={5}>
                  <RecordDetail r={r} onChange={replace} onDeleted={() => { list.setData(all.filter((x) => x.id !== r.id)); setOpen(null); }} />
                </td></tr>
              ),
            ]
          ))}</tbody></table>
        ) : list.data ? (
          <Empty>{filtering ? "Nothing matches your filters." : manager ? (employeeId ? "No reviews or disciplinary actions yet." : "No reviews or disciplinary actions yet. Start one with the buttons above.") : "Nothing has been shared with you yet."}</Empty>
        ) : null}
      </div>
    </>
  );
}

/** Employee page box: this person's reviews and disciplinary actions. */
export function EmployeeRecordsBox({ employeeId, firstName, isSelf }: { employeeId: string; firstName: string; isSelf: boolean }) {
  const { can } = useAuth();
  const manager = can("manager", "reviews") && !isSelf;
  const [newKind, setNewKind] = useState<RecordKind | null>(null);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{isSelf ? "My reviews" : "Reviews & discipline"}</h2>
        {manager && !newKind && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setNewKind("review")}>New review</button>
            <button className="btn sm" onClick={() => setNewKind("discipline")}>New disciplinary action</button>
          </div>
        )}
      </div>
      <RecordList employeeId={employeeId} compact newKind={newKind} onNewDone={() => setNewKind(null)} />
      <Link href="/reviews" className="muted" style={{ fontSize: 13 }}>{isSelf ? "See all" : `All reviews & discipline →`}</Link>
    </div>
  );
}
