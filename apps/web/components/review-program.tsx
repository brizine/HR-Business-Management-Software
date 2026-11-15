"use client";
import { useState } from "react";
import Link from "next/link";
import {
  DEFAULT_REVIEW_PROGRAM, EMPLOYMENT_TYPES, REVIEW_TYPES, REVIEW_TYPE_LABELS, describeReviewRule,
  type ReviewDueStatus, type ReviewProgram, type ReviewRule,
} from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { useMenuData } from "@/lib/menus";
import { Empty, ErrorBox } from "./ui";

type Due = {
  ruleId: string; ruleName: string; reviewType: string; dueDate: string; status: ReviewDueStatus; daysLeft: number;
  employeeId: string; firstName: string; lastName: string; title: string | null; managerId: string | null;
};
type Schedule = { program: ReviewProgram; today: string; due: Due[]; noHireDate: { id: string; name: string }[] };

const STATUS_LABEL: Record<ReviewDueStatus, string> = { overdue: "Overdue", due_soon: "Due soon", upcoming: "Upcoming" };
const STATUS_TONE: Record<ReviewDueStatus, string> = { overdue: "bad", due_soon: "warn", upcoming: "" };

function when(d: Due) {
  if (d.daysLeft < 0) return `${-d.daysLeft} day${d.daysLeft === -1 ? "" : "s"} overdue`;
  if (d.daysLeft === 0) return "Today";
  return `In ${d.daysLeft} day${d.daysLeft === 1 ? "" : "s"}`;
}

/**
 * Reviews coming due under the company's review program, with "Start review"; admins edit the
 * program (which reviews, when, who, and when reminders go out).
 */
export function ReviewProgramBox({ onStart, refreshKey }: { onStart: (employeeId: string, reviewType: string) => void; refreshKey?: number }) {
  const { can } = useAuth();
  const admin = can("admin", "reviews");
  const data = useApi<Schedule>(`/reviews/program?k=${refreshKey ?? 0}`);
  const [editing, setEditing] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(false);
  const program = data.data?.program;
  const due = data.data?.due ?? [];
  const needed = due.filter((d) => d.status !== "upcoming");
  const upcoming = due.filter((d) => d.status === "upcoming");
  const shown = showUpcoming ? due : needed;
  const overdue = needed.filter((d) => d.status === "overdue").length;
  const noHire = data.data?.noHireDate ?? [];

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Review Program</h2>
          {program && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              {program.enabled
                ? program.rules.filter((r) => r.active).map((r) => `${r.name}: ${describeReviewRule(r).toLowerCase()}`).join(" · ") || "No reviews set up."
                : "Off. Turn it on to see when each person's reviews are due and remind their manager."}
            </p>
          )}
        </div>
        {admin && program && !editing && <button className="btn primary sm" onClick={() => setEditing(true)}>{program.enabled ? "Edit program" : "Set up review program"}</button>}
      </div>
      <ErrorBox error={data.error} />
      {editing && program && (
        <ProgramEditor program={program} onCancel={() => setEditing(false)} onSaved={(s) => { data.setData(s); setEditing(false); }} />
      )}
      {program?.enabled && !editing && (
        <>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <span><strong>{needed.length}</strong> need{needed.length === 1 ? "s" : ""} a review{overdue ? <> (<span style={{ color: "var(--danger, #c0392b)" }}>{overdue} overdue</span>)</> : null}</span>
            {upcoming.length > 0 && (
              <label className="check" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={showUpcoming} onChange={(e) => setShowUpcoming(e.target.checked)} /> Show upcoming ({upcoming.length})
              </label>
            )}
          </div>
          {noHire.length > 0 && (
            <p role="status" style={{ margin: 0, fontSize: 14 }}>
              ⚠ {noHire.length} {noHire.length === 1 ? "person has" : "people have"} no hire date, so their reviews can&apos;t be scheduled. Add it on their profile:{" "}
              {noHire.slice(0, 12).map((p, i) => <span key={p.id}>{i ? ", " : ""}<Link href={`/people/${p.id}`}>{p.name}</Link></span>)}
              {noHire.length > 12 ? ` and ${noHire.length - 12} more` : ""}.
            </p>
          )}
          {shown.length ? (
            <table>
              <thead><tr><th>Employee</th><th>Review</th><th>Due</th><th>Status</th><th /></tr></thead>
              <tbody>{shown.map((d) => (
                <tr key={`${d.employeeId}:${d.ruleId}`}>
                  <td><strong>{d.firstName} {d.lastName}</strong>{d.title && <div className="muted" style={{ fontSize: 12 }}>{d.title}</div>}</td>
                  <td>{d.ruleName}</td>
                  <td>{fmtDate(d.dueDate)}<div className="muted" style={{ fontSize: 12 }}>{when(d)}</div></td>
                  <td><span className={`badge ${STATUS_TONE[d.status]}`}>{STATUS_LABEL[d.status]}</span></td>
                  <td><button className="btn sm primary" onClick={() => onStart(d.employeeId, d.reviewType)}>Start review</button></td>
                </tr>
              ))}</tbody>
            </table>
          ) : (
            <Empty>{upcoming.length ? "Nobody is due a review right now." : "No reviews are scheduled. Check that people have a hire date."}</Empty>
          )}
        </>
      )}
    </div>
  );
}

const newRule = (): ReviewRule => ({
  id: `r${Date.now().toString(36)}`, name: "", reviewType: "annual", schedule: "every", months: 12, anchor: "hire",
  remindDaysBefore: 14, employmentTypes: [], active: true,
});

/** Edit the review program: on/off, the reviews (name, type, when), reminders. */
function ProgramEditor({ program, onSaved, onCancel }: { program: ReviewProgram; onSaved: (s: Schedule) => void; onCancel: () => void }) {
  const { label } = useMenuData();
  const [enabled, setEnabled] = useState(program.enabled);
  const [repeat, setRepeat] = useState<string>(program.repeatOverdueDays ? String(program.repeatOverdueDays) : "");
  const [rules, setRules] = useState<ReviewRule[]>(program.rules);
  const { busy, error, run } = useAction();
  const update = (i: number, p: Partial<ReviewRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const num = (v: string) => (v === "" ? undefined : Math.round(Number(v)));

  return (
    <form className="stack review-program-editor" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const body = {
          enabled,
          repeatOverdueDays: repeat ? Math.round(Number(repeat)) : null,
          rules: rules.map((r) => ({
            ...r,
            days: r.schedule === "after_hire" ? r.days : undefined,
            months: r.schedule === "every" ? r.months : undefined,
            anchor: r.schedule === "every" ? r.anchor ?? "hire" : undefined,
            anchorDate: r.schedule === "every" && r.anchor === "date" ? r.anchorDate : undefined,
          })),
        };
        onSaved(await api<Schedule>("/reviews/program", { method: "PUT", body }));
      });
    }}>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <span><strong>Review program on</strong> (track when reviews are due and send reminders)</span></label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Reminders go to the person&apos;s manager and to owners/admins who manage reviews, when a review enters its reminder window and again
        while it&apos;s overdue. Writing a review of the matching type (dated up to 60 days early, or later) marks it done. Reviews that were due
        before the program was first turned on aren&apos;t chased.
      </p>

      {rules.map((r, i) => (
        <fieldset key={r.id} className="card stack" style={{ margin: 0 }}>
          <div className="formgrid">
            <label>Name<input value={r.name} required maxLength={80} placeholder="e.g. 6-month review" onChange={(e) => update(i, { name: e.target.value })} /></label>
            <label>Review type
              <select value={r.reviewType} onChange={(e) => update(i, { reviewType: e.target.value as ReviewRule["reviewType"] })}>
                {REVIEW_TYPES.map((t) => <option key={t} value={t}>{REVIEW_TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            <label>When
              <select value={r.schedule} onChange={(e) => update(i, e.target.value === "after_hire" ? { schedule: "after_hire", days: r.days ?? 90 } : { schedule: "every", months: r.months ?? 12, anchor: r.anchor ?? "hire" })}>
                <option value="after_hire">Once, X days after hire</option>
                <option value="every">Repeating, every X months</option>
              </select>
            </label>
            {r.schedule === "after_hire" ? (
              <label>Days after hire<input type="number" min={1} max={3650} required value={r.days ?? ""} onChange={(e) => update(i, { days: num(e.target.value) })} /></label>
            ) : (
              <>
                <label>Every X months<input type="number" min={1} max={60} required value={r.months ?? ""} onChange={(e) => update(i, { months: num(e.target.value) })} /></label>
                <label>Counted from
                  <select value={r.anchor ?? "hire"} onChange={(e) => update(i, { anchor: e.target.value as ReviewRule["anchor"] })}>
                    <option value="hire">Hire date (anniversary)</option>
                    <option value="last_review">Their last review of this type</option>
                    <option value="date">A set date (same for everyone)</option>
                  </select>
                </label>
                {r.anchor === "date" && <label>First date<input type="date" required value={r.anchorDate ?? ""} onChange={(e) => update(i, { anchorDate: e.target.value || undefined })} /></label>}
              </>
            )}
            <label>Remind X days before<input type="number" min={0} max={180} required value={r.remindDaysBefore} onChange={(e) => update(i, { remindDaysBefore: num(e.target.value) ?? 0 })} /></label>
          </div>
          <div className="row" style={{ gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 13 }}>Applies to:</span>
            {EMPLOYMENT_TYPES.map((t) => (
              <label key={t} className="check" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={r.employmentTypes.includes(t)} onChange={(e) => update(i, { employmentTypes: e.target.checked ? [...r.employmentTypes, t] : r.employmentTypes.filter((x) => x !== t) })} /> {label("employmentType", t).replace(/^./, (c) => c.toUpperCase())}
              </label>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>{r.employmentTypes.length ? "" : "(none ticked = everyone)"}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label className="check" style={{ fontSize: 14 }}><input type="checkbox" checked={r.active} onChange={(e) => update(i, { active: e.target.checked })} /> Active</label>
            <button type="button" className="btn sm danger" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
          </div>
        </fieldset>
      ))}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn sm" disabled={rules.length >= 20} onClick={() => setRules([...rules, newRule()])}>+ Add a review</button>
        <button type="button" className="btn sm" onClick={() => confirm("Replace these reviews with the standard 90-day and annual reviews?") && setRules(DEFAULT_REVIEW_PROGRAM.rules)}>Use the standard program</button>
      </div>
      <label style={{ maxWidth: 320 }}>While overdue, remind again every X days
        <input type="number" min={1} max={90} value={repeat} placeholder="Blank: remind once" onChange={(e) => setRepeat(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>Save review program</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
