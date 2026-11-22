"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { videoEmbedUrl } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ProgressBar, chapters, type Enrollment, type LessonOutline } from "@/components/training";

type Lesson = { id: string; courseId: string; chapter: string | null; title: string; content: string; videoUrl: string | null; quiz: { kind: string; question: string; options: string[] }[]; passingScore: number; progress: { completedAt: string | null; quizScore: number | null; attempts: number } | null; preview: boolean };
type Result = { score: number; passed: boolean; results: boolean[]; passingScore: number; attempts: number; explanations: (string | null)[]; correctAnswers: number[][] | null; enrollment: Enrollment };

export default function LessonPage({ params }: { params: Promise<{ id: string; lessonId: string }> }) {
  const { id, lessonId } = use(params);
  const router = useRouter();
  const course = useApi<{ title: string; lessons: LessonOutline[]; enrollment: Enrollment | null }>(`/training/courses/${id}`);
  const lesson = useApi<Lesson>(`/training/lessons/${lessonId}`);
  const [answers, setAnswers] = useState<number[][]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { setAnswers([]); setResult(null); }, [lessonId]);
  const l = lesson.data;
  const c = course.data;
  if (!l || !c) return <ErrorBox error={lesson.error || course.error} />;
  const done = (lid: string) => !!c.enrollment?.progress?.find((p) => p.lessonId === lid && p.completedAt);
  const i = c.lessons.findIndex((x) => x.id === l.id);
  const next = c.lessons[i + 1];
  const prev = c.lessons[i - 1];
  const finished = done(l.id) || !!result?.passed;
  const embed = videoEmbedUrl(l.videoUrl);
  const toggle = (q: number, o: number, multi: boolean) => {
    const cur = answers[q] ?? [];
    const nextA = [...answers];
    nextA[q] = multi ? (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]) : [o];
    setAnswers(nextA);
  };
  const afterDone = () => { course.reload(); lesson.reload(); };

  return (
    <>
      <PageHead title={l.title} sub={<Link href={`/training/${id}`}>{c.title}</Link>}>
        {prev && <Link className="btn" href={`/training/${id}/lesson/${prev.id}`}>← Previous</Link>}
        {next && <Link className="btn" href={`/training/${id}/lesson/${next.id}`}>Next →</Link>}
      </PageHead>
      <div className="lesson-layout" data-lkeep>
        <nav className="card lesson-nav" aria-label="Lessons">
          {c.enrollment && <><ProgressBar percent={c.enrollment.percent} /><div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{c.enrollment.lessonsDone} of {c.enrollment.lessonsTotal} done</div></>}
          {chapters(c.lessons).map((g, gi) => (
            <div key={gi}>
              {g.chapter && <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", margin: "8px 0 2px" }}>{g.chapter}</div>}
              {g.lessons.map((x) => (
                <Link key={x.id} href={`/training/${id}/lesson/${x.id}`} className={`lesson-nav-item${x.id === l.id ? " active" : ""}`}>
                  <span className="lesson-check">{done(x.id) ? "✓" : ""}</span>{x.title}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="stack" style={{ minWidth: 0 }}>
          {l.preview && <div className="card muted">Preview: you&apos;re not enrolled, so progress isn&apos;t saved.</div>}
          {l.videoUrl && (embed ? (
            <div className="video-wrap"><iframe src={embed} title={`Video: ${l.title}`} allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowFullScreen /></div>
          ) : <a className="btn" href={l.videoUrl} target="_blank" rel="noopener noreferrer">▶ Watch the video</a>)}
          {l.content.trim() && <div className="card"><Markdown>{l.content}</Markdown></div>}

          {l.quiz.length > 0 ? (
            <form className="card stack" onSubmit={(e) => {
              e.preventDefault();
              run(async () => { const r = await api<Result>(`/training/lessons/${l.id}/quiz`, { body: { answers: l.quiz.map((_, qi) => answers[qi] ?? []) } }); setResult(r); if (r.passed) afterDone(); });
            }}>
              <h2 style={{ margin: 0 }}>Quiz</h2>
              <p className="muted" style={{ margin: 0 }}>Score {l.passingScore}% or more to pass.{l.progress?.attempts ? ` Best so far: ${l.progress.quizScore}% (${l.progress.attempts} tr${l.progress.attempts === 1 ? "y" : "ies"}).` : ""}</p>
              {l.quiz.map((q, qi) => (
                <fieldset key={qi} className={`quiz-q${result ? (result.results[qi] ? " right" : " wrong") : ""}`}>
                  <legend>{qi + 1}. {q.question}{q.kind === "multiple" && <span className="muted" style={{ fontWeight: 400 }}> (pick all that apply)</span>}</legend>
                  {q.options.map((o, oi) => (
                    <label key={oi} className={`check${result?.correctAnswers?.[qi]?.includes(oi) ? " correct-answer" : ""}`}>
                      <input type={q.kind === "multiple" ? "checkbox" : "radio"} name={`q${qi}`} checked={(answers[qi] ?? []).includes(oi)} onChange={() => toggle(qi, oi, q.kind === "multiple")} disabled={!!result?.passed} />
                      {o}
                    </label>
                  ))}
                  {result && <div className="muted" style={{ fontSize: 13 }}>{result.results[qi] ? "✓ Right" : "✗ Not quite"}{result.explanations[qi] ? `: ${result.explanations[qi]}` : ""}</div>}
                </fieldset>
              ))}
              {result && <div className={result.passed ? "card quiz-pass" : "card quiz-fail"} role="status">{result.passed ? `Passed with ${result.score}%!` : `You scored ${result.score}%. You need ${result.passingScore}%. Review the lesson and try again.`}</div>}
              <ErrorBox error={error} />
              {!l.preview && !result?.passed && <div className="row"><button className="btn primary" disabled={busy}>{result ? "Try again" : "Submit answers"}</button>{result && <button type="button" className="btn" onClick={() => { setResult(null); setAnswers([]); }}>Clear answers</button>}</div>}
            </form>
          ) : !l.preview && !finished ? (
            <div><button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/training/lessons/${l.id}/complete`, { method: "POST" }); afterDone(); if (next) router.push(`/training/${id}/lesson/${next.id}`); })}>Mark as done{next ? " and continue" : ""}</button><ErrorBox error={error} /></div>
          ) : null}

          {finished && (
            <div className="card row" style={{ justifyContent: "space-between" }}>
              <span>✓ Lesson done.{c.enrollment?.completedAt ? " You've finished the course!" : ""}</span>
              {next ? <Link className="btn primary" href={`/training/${id}/lesson/${next.id}`}>Next lesson →</Link> : <Link className="btn primary" href={`/training/${id}`}>Back to the course</Link>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
