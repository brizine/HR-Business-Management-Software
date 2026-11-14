"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AUTO_ASSIGN, ENROLLMENT_STATUS_LABELS, QUESTION_KINDS, type EnrollmentStatus, type QuizQuestion } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { useMenuData } from "@/lib/menus";
import { Markdown } from "./markdown";
import { ErrorBox } from "./ui";

export type Enrollment = {
  id: string; courseId: string; employeeId: string; status: EnrollmentStatus; percent: number; lessonsDone: number; lessonsTotal: number;
  dueDate: string | null; completedAt: string | null; expiresAt: string | null; source: string;
  progress?: { lessonId: string; completedAt: string | null; quizScore: number | null; attempts: number }[];
};
export type Course = {
  id: string; title: string; description: string | null; category: string | null; published: boolean; passingScore: number;
  validityMonths: number | null; dueDays: number | null; autoAssign: (typeof AUTO_ASSIGN)[number]; autoAssignTo: string[]; selfEnroll: boolean;
  lessons: number | LessonOutline[]; enrollment: Enrollment | null;
  stats?: { assigned: number; completed: number; overdue: number; expired: number };
};
export type LessonOutline = { id: string; chapter: string | null; title: string; position: number; hasVideo: boolean; questions: number };

const TONE: Record<EnrollmentStatus, string> = { not_started: "", in_progress: "warn", completed: "ok", overdue: "bad", expired: "bad" };
export function StatusBadge({ status }: { status: EnrollmentStatus }) {
  return <span className={`badge ${TONE[status]}`}>{ENROLLMENT_STATUS_LABELS[status].toLowerCase()}</span>;
}

/** Lessons grouped under their chapter headings, in order. */
export function chapters(lessons: LessonOutline[]) {
  const groups: { chapter: string | null; lessons: LessonOutline[] }[] = [];
  for (const l of lessons) {
    const last = groups.at(-1);
    if (last && last.chapter === l.chapter) last.lessons.push(l); else groups.push({ chapter: l.chapter, lessons: [l] });
  }
  return groups;
}

export function ProgressBar({ percent }: { percent: number }) {
  return <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${percent}%` }} /></div>;
}

/** A course in the catalog or "My training". */
export function CourseCard({ c }: { c: Course }) {
  const lessons = typeof c.lessons === "number" ? c.lessons : c.lessons.length;
  const e = c.enrollment;
  return (
    <Link href={`/training/${c.id}`} className="card course-card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          {c.category && <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase" }}>{c.category}</div>}
          <h3 style={{ margin: "2px 0" }}>{c.title}</h3>
        </div>
        {!c.published ? <span className="badge">draft</span> : e ? <StatusBadge status={e.status} /> : null}
      </div>
      {c.description && <p className="muted course-desc">{c.description}</p>}
      <div className="muted" style={{ fontSize: 13 }}>
        {lessons} lesson{lessons === 1 ? "" : "s"}{c.validityMonths ? ` · retake every ${c.validityMonths} month${c.validityMonths === 1 ? "" : "s"}` : ""}
        {e?.dueDate && !e.completedAt ? ` · due ${fmtDate(e.dueDate)}` : ""}
        {e?.completedAt ? ` · done ${fmtDate(e.completedAt)}${e.expiresAt ? `, good until ${fmtDate(e.expiresAt)}` : ""}` : ""}
      </div>
      {e && <ProgressBar percent={e.percent} />}
      {c.stats && <div className="muted" style={{ fontSize: 12 }}>{c.stats.completed} of {c.stats.assigned} completed{c.stats.overdue ? ` · ${c.stats.overdue} overdue` : ""}{c.stats.expired ? ` · ${c.stats.expired} expired` : ""}</div>}
    </Link>
  );
}

/** Course settings: title, publishing, passing score, expiry, due date, who gets it. */
export function CourseForm({ course, onSaved }: { course?: Course; onSaved?: (c: Course) => void }) {
  const router = useRouter();
  const { menus } = useMenuData();
  const [c, setC] = useState({
    title: course?.title ?? "", description: course?.description ?? "", category: course?.category ?? "", published: course?.published ?? false,
    passingScore: course?.passingScore ?? 80, validityMonths: course?.validityMonths ?? null as number | null, dueDays: course?.dueDays ?? 14 as number | null,
    autoAssign: course?.autoAssign ?? "none", autoAssignTo: course?.autoAssignTo ?? [] as string[], selfEnroll: course?.selfEnroll ?? true,
  });
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const set = (p: Partial<typeof c>) => { setC({ ...c, ...p }); setSaved(false); };
  const choices = c.autoAssign === "titles" ? menus.jobTitles : c.autoAssign === "departments" ? menus.departments : [];
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const saved = await api<Course>(course ? `/training/courses/${course.id}` : "/training/courses", { method: course ? "PUT" : "POST", body: c });
        setSaved(true);
        if (course) onSaved?.(saved); else router.push(`/training/${saved.id}/edit`);
      });
    }}>
      <h2 style={{ margin: 0 }}>{course ? "Course Settings" : "New Course"}</h2>
      <div className="formgrid">
        <label style={{ gridColumn: "span 2" }}>Title<input value={c.title} onChange={(e) => set({ title: e.target.value })} required maxLength={150} placeholder="e.g. Pesticide safety" /></label>
        <label>Category<input value={c.category} onChange={(e) => set({ category: e.target.value })} maxLength={60} placeholder="e.g. Safety" /></label>
      </div>
      <label>Description<textarea value={c.description} onChange={(e) => set({ description: e.target.value })} rows={3} maxLength={5000} placeholder="What people will learn" /></label>
      <div className="formgrid">
        <label>Passing score for quizzes (%)<input type="number" min={0} max={100} value={c.passingScore} onChange={(e) => set({ passingScore: Number(e.target.value) })} /></label>
        <label>Due after assigning (days)<input type="number" min={1} max={365} value={c.dueDays ?? ""} placeholder="No due date" onChange={(e) => set({ dueDays: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Retake every (months)<input type="number" min={1} max={120} value={c.validityMonths ?? ""} placeholder="Never expires" onChange={(e) => set({ validityMonths: e.target.value ? Number(e.target.value) : null })} />
          <span className="muted" style={{ fontSize: 12 }}>E.g. 12 for yearly safety training. People are assigned it again when it expires.</span>
        </label>
      </div>
      <div className="formgrid">
        <label>Assign automatically to
          <select value={c.autoAssign} onChange={(e) => set({ autoAssign: e.target.value as typeof c.autoAssign, autoAssignTo: [] })}>
            <option value="none">Nobody (assign by hand)</option>
            <option value="everyone">Everyone</option>
            <option value="titles">People with these job titles</option>
            <option value="departments">People in these departments</option>
          </select>
        </label>
      </div>
      {choices.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px" }}>
          {choices.map((t) => (
            <label key={t} className="check"><input type="checkbox" checked={c.autoAssignTo.includes(t)} onChange={(e) => set({ autoAssignTo: e.target.checked ? [...c.autoAssignTo, t] : c.autoAssignTo.filter((x) => x !== t) })} />{t}</label>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={c.selfEnroll} onChange={(e) => set({ selfEnroll: e.target.checked })} /> Anyone can sign themselves up from the catalog</label>
      <label className="check"><input type="checkbox" checked={c.published} onChange={(e) => set({ published: e.target.checked })} /> Published (people can see it; automatic assignments go out when you save)</label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>{course ? "Save settings" : "Create course"}</button>{saved && course && <span className="muted" role="status">Saved.</span>}</div>
    </form>
  );
}

const BLANK_Q = (): QuizQuestion => ({ kind: "single", question: "", options: ["", ""], correct: [0] });

/** Add or edit a lesson: chapter, title, text (wiki formatting), video, quiz. */
export function LessonForm({ courseId, lesson, onSaved, onCancel }: { courseId: string; lesson?: { id: string; chapter: string | null; title: string; content: string; videoUrl: string | null; quiz: QuizQuestion[] }; onSaved: () => void; onCancel: () => void }) {
  const [chapter, setChapter] = useState(lesson?.chapter ?? "");
  const [title, setTitle] = useState(lesson?.title ?? "");
  const [content, setContent] = useState(lesson?.content ?? "");
  const [videoUrl, setVideoUrl] = useState(lesson?.videoUrl ?? "");
  const [quiz, setQuiz] = useState<QuizQuestion[]>(lesson?.quiz ?? []);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const { busy, error, run } = useAction();
  const setQ = (i: number, p: Partial<QuizQuestion>) => setQuiz(quiz.map((q, j) => (j === i ? { ...q, ...p } : q)));

  return (
    <form className="card stack lesson-form" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api(lesson ? `/training/lessons/${lesson.id}` : `/training/courses/${courseId}/lessons`, { method: lesson ? "PUT" : "POST", body: { chapter, title, content, videoUrl, quiz } });
        onSaved();
      });
    }}>
      <h3 style={{ margin: 0 }}>{lesson ? `Edit Lesson: ${lesson.title}` : "New Lesson"}</h3>
      <div className="formgrid">
        <label>Chapter<input value={chapter} onChange={(e) => setChapter(e.target.value)} maxLength={120} placeholder="e.g. Getting started" /></label>
        <label style={{ gridColumn: "span 2" }}>Lesson title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={150} /></label>
      </div>
      <label>Video link (optional)<input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=… or Vimeo" /></label>
      <div className="card" style={{ padding: 0, margin: 0 }}>
        <div className="tabs" role="tablist" aria-label="Lesson text">
          <button type="button" role="tab" aria-selected={tab === "write"} onClick={() => setTab("write")}>Write</button>
          <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Preview</button>
        </div>
        <div style={{ padding: 12 }}>
          {tab === "write"
            ? <><textarea aria-label="Lesson text" value={content} onChange={(e) => setContent(e.target.value)} rows={12} /><p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Formatting: # Heading, **bold**, - lists, [link](https://…), | tables |</p></>
            : content.trim() ? <Markdown>{content}</Markdown> : <p className="muted">Nothing to preview yet.</p>}
        </div>
      </div>

      <div className="stack">
        <strong>Quiz {quiz.length ? `(${quiz.length} question${quiz.length === 1 ? "" : "s"})` : "(optional)"}</strong>
        <span className="muted" style={{ fontSize: 13 }}>With a quiz, the lesson is done once they pass it. Without one, they mark it done.</span>
        {quiz.map((q, i) => (
          <fieldset key={i} className="quiz-edit">
            <legend>Question {i + 1}</legend>
            <div className="formgrid">
              <label style={{ gridColumn: "span 2" }}>Question<input value={q.question} onChange={(e) => setQ(i, { question: e.target.value })} required /></label>
              <label>Type
                <select value={q.kind} onChange={(e) => {
                  const kind = e.target.value as QuizQuestion["kind"];
                  setQ(i, kind === "true_false" ? { kind, options: ["True", "False"], correct: [0] } : { kind, correct: kind === "single" ? [q.correct[0] ?? 0] : q.correct });
                }}>
                  {QUESTION_KINDS.map((k) => <option key={k} value={k}>{k === "single" ? "One right answer" : k === "multiple" ? "Several right answers" : "True / false"}</option>)}
                </select>
              </label>
            </div>
            {q.options.map((o, j) => (
              <div key={j} className="row" style={{ flexWrap: "nowrap" }}>
                <input type={q.kind === "multiple" ? "checkbox" : "radio"} name={`q${i}-correct`} checked={q.correct.includes(j)} aria-label={`Option ${j + 1} is right`}
                  onChange={(e) => setQ(i, { correct: q.kind === "multiple" ? (e.target.checked ? [...q.correct, j] : q.correct.filter((x) => x !== j)) : [j] })} />
                <input value={o} disabled={q.kind === "true_false"} aria-label={`Option ${j + 1}`} required style={{ flex: 1 }}
                  onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} />
                {q.kind !== "true_false" && q.options.length > 2 && (
                  <button type="button" className="btn sm" aria-label="Remove option" onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== j), correct: q.correct.filter((x) => x !== j).map((x) => (x > j ? x - 1 : x)) })}>×</button>
                )}
              </div>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>Tick the right answer{q.kind === "multiple" ? "s" : ""}.</span>
            <div className="row">
              {q.kind !== "true_false" && q.options.length < 8 && <button type="button" className="btn sm" onClick={() => setQ(i, { options: [...q.options, ""] })}>Add option</button>}
              <button type="button" className="btn sm danger" onClick={() => setQuiz(quiz.filter((_, j) => j !== i))}>Remove question</button>
            </div>
            <label>Explanation shown after answering (optional)<input value={q.explanation ?? ""} onChange={(e) => setQ(i, { explanation: e.target.value || undefined })} /></label>
          </fieldset>
        ))}
        <div><button type="button" className="btn sm" onClick={() => setQuiz([...quiz, BLANK_Q()])}>Add a question</button></div>
      </div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>{lesson ? "Save lesson" : "Add lesson"}</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

/** A printable certificate of completion. */
export function printCertificate(opts: { name: string; course: string; company: string; completed: string; expires: string | null }) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Certificate – ${esc(opts.course)}</title>
<style>@page{size:landscape;margin:0}body{margin:0;font-family:Georgia,serif;color:#1f2937}.c{margin:40px;border:10px double #1e3a8a;padding:60px;text-align:center;height:calc(100vh - 220px);display:flex;flex-direction:column;justify-content:center;gap:14px}
h1{font-size:44px;margin:0;color:#1e3a8a;letter-spacing:2px}.n{font-size:36px;border-bottom:1px solid #9ca3af;display:inline-block;padding:0 40px 6px}.s{font-size:18px;color:#4b5563}.t{font-size:28px;font-weight:bold}</style></head>
<body><div class="c"><div class="s">${esc(opts.company)}</div><h1>Certificate of Completion</h1><div class="s">This certifies that</div><div><span class="n">${esc(opts.name)}</span></div>
<div class="s">has completed</div><div class="t">${esc(opts.course)}</div><div class="s">on ${esc(opts.completed)}${opts.expires ? ` · valid until ${esc(opts.expires)}` : ""}</div></div></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return alert("Allow pop-ups for this site to print the certificate.");
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** Employee page box: this person's training. */
export function EmployeeTrainingBox({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const { data: rows, error } = useApi<any[]>(`/training/report?employeeId=${employeeId}`);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{isSelf ? "My Training" : "Training"}</h2>
        <Link href="/training" className="muted" style={{ fontSize: 13 }}>{isSelf ? "Open training →" : "All training →"}</Link>
      </div>
      <ErrorBox error={error} />
      {rows && (rows.length ? (
        <table><tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/training/${r.courseId}`}>{r.course?.title}</Link><div className="muted" style={{ fontSize: 12 }}>{r.completedAt ? `Done ${fmtDate(r.completedAt)}${r.expiresAt ? `, good until ${fmtDate(r.expiresAt)}` : ""}` : r.dueDate ? `Due ${fmtDate(r.dueDate)}` : ""}</div></td>
            <td style={{ width: 140 }}><ProgressBar percent={r.percent} /></td>
            <td style={{ textAlign: "right" }}><StatusBadge status={r.status} /></td>
          </tr>
        ))}</tbody></table>
      ) : <p className="muted" style={{ margin: 0 }}>No training assigned.</p>)}
    </div>
  );
}
