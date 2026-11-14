"use client";
import Link from "next/link";
import { useState } from "react";
import { ENROLLMENT_STATUS_LABELS, isInactive, type EnrollmentStatus } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { CourseCard, ProgressBar, StatusBadge, type Course } from "@/components/training";

type Tab = "mine" | "catalog" | "progress";
type Catalog = { canManage: boolean; canEdit: boolean; today: string; courses: Course[] };

/** Managers: everyone's progress, with filters, and assigning courses. */
function Progress({ courses }: { courses: Course[] }) {
  const report = useApi<any[]>("/training/report");
  const staff = useApi<any[]>("/employees");
  const [f, setF] = useState({ q: "", course: "", status: "" });
  const [assigning, setAssigning] = useState(false);
  const [pick, setPick] = useState<{ course: string; people: string[]; due: string }>({ course: "", people: [], due: "" });
  const [note, setNote] = useState<string | null>(null);
  const action = useAction();
  const q = f.q.trim().toLowerCase();
  const rows = (report.data ?? []).filter((r) =>
    (!q || `${r.employee?.firstName} ${r.employee?.lastName} ${r.employee?.title ?? ""} ${r.course?.title}`.toLowerCase().includes(q)) &&
    (!f.course || r.courseId === f.course) && (!f.status || r.status === f.status));
  const published = courses.filter((c) => c.published);
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status));
  return (
    <>
      <form className="card filters" role="search" aria-label="Filter training progress" onSubmit={(e) => e.preventDefault()}>
        <label>Search<input type="search" placeholder="Name, job title, course…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <label>Course
          <select value={f.course} onChange={(e) => setF({ ...f, course: e.target.value })}>
            <option value="">All courses</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>
        <label>Status
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Any</option>
            {(Object.keys(ENROLLMENT_STATUS_LABELS) as EnrollmentStatus[]).map((s) => <option key={s} value={s}>{ENROLLMENT_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        {(f.q || f.course || f.status) && <button type="button" className="btn" onClick={() => setF({ q: "", course: "", status: "" })}>Clear filters</button>}
        <div style={{ flex: 1 }} />
        {published.length > 0 && <button type="button" className="btn primary" onClick={() => setAssigning(!assigning)}>Assign a course</button>}
      </form>
      {note && <div className="card row" style={{ justifyContent: "space-between" }}><span>{note}</span><button className="btn sm" onClick={() => setNote(null)}>×</button></div>}
      {assigning && (
        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => {
            const r = await api<{ assigned: number; skipped: number }>(`/training/courses/${pick.course}/assign`, { body: { employeeIds: pick.people, dueDate: pick.due || undefined } });
            setNote(`Assigned to ${r.assigned} ${r.assigned === 1 ? "person" : "people"}${r.skipped ? `; ${r.skipped} already had it` : ""}. They've been notified.`);
            setAssigning(false);
            setPick({ course: "", people: [], due: "" });
            report.reload();
          });
        }}>
          <h2 style={{ margin: 0 }}>Assign a Course</h2>
          <div className="formgrid">
            <label>Course
              <select required value={pick.course} onChange={(e) => setPick({ ...pick, course: e.target.value })}>
                <option value="" disabled>Choose…</option>
                {published.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </label>
            <label>Due date<input type="date" value={pick.due} onChange={(e) => setPick({ ...pick, due: e.target.value })} /><span className="muted" style={{ fontSize: 12 }}>Blank: the course&apos;s usual due date.</span></label>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px" }}>
            <button type="button" className="btn sm" onClick={() => setPick({ ...pick, people: pick.people.length === people.length ? [] : people.map((p) => p.id) })}>{pick.people.length === people.length ? "Select none" : "Select everyone"}</button>
            {people.map((p) => (
              <label key={p.id} className="check"><input type="checkbox" checked={pick.people.includes(p.id)} onChange={(e) => setPick({ ...pick, people: e.target.checked ? [...pick.people, p.id] : pick.people.filter((x) => x !== p.id) })} />{p.firstName} {p.lastName}{p.title ? <span className="muted"> · {p.title}</span> : null}</label>
            ))}
          </div>
          <ErrorBox error={action.error} />
          <div className="row"><button className="btn primary" disabled={action.busy || !pick.course || !pick.people.length}>Assign to {pick.people.length || ""} {pick.people.length === 1 ? "person" : "people"}</button><button type="button" className="btn" onClick={() => setAssigning(false)}>Cancel</button></div>
        </form>
      )}
      <div className="card tablewrap">
        <ErrorBox error={report.error} />
        {rows.length ? (
          <table>
            <thead><tr><th>Employee</th><th>Course</th><th>Progress</th><th>Due</th><th>Completed</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/people/${r.employeeId}`}>{r.employee?.firstName} {r.employee?.lastName}</Link>{r.employee?.title && <div className="muted" style={{ fontSize: 12 }}>{r.employee.title}</div>}</td>
                <td><Link href={`/training/${r.courseId}`}>{r.course?.title}</Link></td>
                <td style={{ minWidth: 130 }}><ProgressBar percent={r.percent} /><div className="muted" style={{ fontSize: 12 }}>{r.lessonsDone} of {r.lessonsTotal} lessons</div></td>
                <td>{r.dueDate ? fmtDate(r.dueDate) : "—"}</td>
                <td>{r.completedAt ? fmtDate(r.completedAt) : "—"}{r.expiresAt && <div className="muted" style={{ fontSize: 12 }}>until {fmtDate(r.expiresAt)}</div>}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{!r.completedAt && <button className="btn sm" onClick={() => confirm(`Remove ${r.course?.title} from ${r.employee?.firstName}?`) && action.run(async () => { await api(`/training/enrollments/${r.id}`, { method: "DELETE" }); report.reload(); })}>Unassign</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : report.data ? <Empty>{report.data.length ? "Nothing matches your filters." : "No training assigned yet."}</Empty> : null}
      </div>
    </>
  );
}

export default function Training() {
  const data = useApi<Catalog>("/training/courses");
  const [tab, setTab] = useState<Tab>("mine");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const d = data.data;
  const mine = (d?.courses ?? []).filter((c) => c.enrollment).sort((a, b) => (a.enrollment!.completedAt ? 1 : 0) - (b.enrollment!.completedAt ? 1 : 0));
  const categories = [...new Set((d?.courses ?? []).map((c) => c.category).filter((x): x is string => !!x))].sort();
  const catalog = (d?.courses ?? []).filter((c) => (!q.trim() || `${c.title} ${c.description ?? ""} ${c.category ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) && (!category || c.category === category));
  const tabs: [Tab, string][] = [["mine", "My training"], ["catalog", "All courses"], ...(d?.canManage ? [["progress", "Team progress"] as [Tab, string]] : [])];

  return (
    <>
      <PageHead title="Training" sub="Courses, lessons and quizzes. Finish every lesson (and pass its quiz) to complete a course.">
        {d?.canEdit && <Link className="btn primary" href="/training/new">New course</Link>}
      </PageHead>
      <div className="row" role="tablist" style={{ gap: 6, marginBottom: 12 }}>
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {!d ? <ErrorBox error={data.error} /> : tab === "mine" ? (
        mine.length ? <div className="course-grid">{mine.map((c) => <CourseCard key={c.id} c={c} />)}</div>
          : <Empty>Nothing assigned to you yet. Browse <button type="button" className="linklike" onClick={() => setTab("catalog")}>all courses</button> to sign up for one.</Empty>
      ) : tab === "catalog" ? (
        <>
          <form className="card filters" role="search" aria-label="Search courses" onSubmit={(e) => e.preventDefault()}>
            <label>Search<input type="search" placeholder="Course name or topic…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            {categories.length > 0 && (
              <label>Category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
          </form>
          {catalog.length ? <div className="course-grid">{catalog.map((c) => <CourseCard key={c.id} c={c} />)}</div> : <Empty>{d.courses.length ? "No courses match." : d.canEdit ? "No courses yet. Create one with New course." : "No courses yet."}</Empty>}
        </>
      ) : <Progress courses={d.courses} />}
    </>
  );
}
