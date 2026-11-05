"use client";
import Link from "next/link";
import { use } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { ProgressBar, StatusBadge, chapters, printCertificate, type Course, type LessonOutline } from "@/components/training";

type Detail = Omit<Course, "lessons"> & { lessons: LessonOutline[]; canManage: boolean; canEdit: boolean };

export default function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useAuth();
  const data = useApi<Detail>(`/training/courses/${id}`);
  const { busy, error, run } = useAction();
  const c = data.data;
  if (!c) return <ErrorBox error={data.error} />;
  const e = c.enrollment;
  const done = (lessonId: string) => !!e?.progress?.find((p) => p.lessonId === lessonId && p.completedAt);
  const next = c.lessons.find((l) => !done(l.id)) ?? c.lessons[0];

  return (
    <>
      <PageHead title={c.title} sub={[c.category, `${c.lessons.length} lesson${c.lessons.length === 1 ? "" : "s"}`, c.validityMonths ? `retake every ${c.validityMonths} months` : null].filter(Boolean).join(" · ")}>
        <Link className="btn" href="/training">All training</Link>
        {c.canEdit && <Link className="btn" href={`/training/${c.id}/edit`}>Edit course</Link>}
      </PageHead>
      <div className="grid cols-2">
        <div className="card stack">
          {!c.published && <div className="badge">Draft: only people who edit training can see it</div>}
          {c.description && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{c.description}</p>}
          {e ? (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}><StatusBadge status={e.status} /><span className="muted">{e.lessonsDone} of {e.lessonsTotal} lessons</span></div>
              <ProgressBar percent={e.percent} />
              <div className="muted" style={{ fontSize: 13 }}>
                {e.completedAt ? `Completed ${fmtDate(e.completedAt)}${e.expiresAt ? `, good until ${fmtDate(e.expiresAt)}` : ""}.` : e.dueDate ? `Due ${fmtDate(e.dueDate)}.` : "No due date."}
                {c.passingScore ? ` Quizzes need ${c.passingScore}% to pass.` : ""}
              </div>
              <div className="row">
                {next && !e.completedAt && <Link className="btn primary" href={`/training/${c.id}/lesson/${next.id}`}>{e.lessonsDone ? "Continue" : "Start"}</Link>}
                {e.completedAt && e.status !== "expired" && (
                  <button className="btn primary" onClick={() => printCertificate({ name: `${me?.user.firstName} ${me?.user.lastName}`, course: c.title, company: me?.company.name ?? "", completed: fmtDate(e.completedAt!), expires: e.expiresAt ? fmtDate(e.expiresAt) : null })}>Print certificate</button>
                )}
              </div>
            </>
          ) : c.published ? (
            <>
              <p className="muted" style={{ margin: 0 }}>{c.selfEnroll ? "You're not signed up for this course yet." : "Ask your manager to assign you this course."}</p>
              <ErrorBox error={error} />
              {c.selfEnroll && <div><button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/training/courses/${c.id}/enroll`, { method: "POST" }); data.reload(); })}>Sign up</button></div>}
            </>
          ) : null}
        </div>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Lessons</h2>
          {c.lessons.length ? chapters(c.lessons).map((g, i) => (
            <div key={i} className="stack" style={{ gap: 4 }}>
              {g.chapter && <div className="muted" style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>{g.chapter}</div>}
              <ol className="lesson-list">
                {g.lessons.map((l) => (
                  <li key={l.id} className={done(l.id) ? "done" : ""}>
                    <span className="lesson-check" aria-label={done(l.id) ? "Done" : "Not done"}>{done(l.id) ? "✓" : ""}</span>
                    {e || c.canEdit ? <Link href={`/training/${c.id}/lesson/${l.id}`}>{l.title}</Link> : <span>{l.title}</span>}
                    <span className="muted" style={{ fontSize: 12 }}>{[l.hasVideo ? "video" : null, l.questions ? `${l.questions}-question quiz` : null].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ol>
            </div>
          )) : <p className="muted" style={{ margin: 0 }}>No lessons yet.</p>}
        </div>
      </div>
    </>
  );
}
