"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Grip, useDragOrder } from "@/components/drag-order";
import { CourseForm, LessonForm, type Course, type LessonOutline } from "@/components/training";

type Detail = Omit<Course, "lessons"> & { lessons: LessonOutline[]; canEdit: boolean };

export default function EditCourse({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const data = useApi<Detail>(`/training/courses/${id}`);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const full = useApi<any>(editing && editing !== "new" ? `/training/lessons/${editing}?edit=1` : null);
  const { busy, error, run } = useAction();
  const c = data.data;
  const drag = useDragOrder((c?.lessons ?? []).map((l) => l.id), (ids) => run(async () => {
    await api(`/training/courses/${id}/lesson-order`, { method: "PUT", body: { ids } });
    await data.reload();
  }), { busy });
  if (!c) return <ErrorBox error={data.error} />;
  if (!c.canEdit) return <p className="muted">Only people who edit training can change courses.</p>;

  return (
    <>
      <PageHead title={`Edit: ${c.title}`} sub={c.published ? "Published" : "Draft (only people who edit training can see it)"}>
        <Link className="btn" href={`/training/${id}`}>View course</Link>
        <button className="btn danger" disabled={busy} onClick={() => confirm(`Delete "${c.title}" and everyone's progress in it?`) && run(async () => { await api(`/training/courses/${id}`, { method: "DELETE" }); router.push("/training"); })}>Delete course</button>
      </PageHead>
      <CourseForm course={c as unknown as Course} onSaved={() => data.reload()} />
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Lessons</h2>
          {!editing && <button className="btn primary" onClick={() => setEditing("new")}>Add a lesson</button>}
        </div>
        <ErrorBox error={error} />
        {c.lessons.length ? (
          <table><tbody ref={drag.box}>{drag.sorted(c.lessons, (l) => l.id).map((l, i) => (
            <tr key={l.id} {...drag.row(l.id)}>
              <td className="drag-col"><Grip drag={drag} id={l.id} name={l.title} /></td>
              <td style={{ width: 40 }} className="muted">{i + 1}</td>
              <td>{l.chapter && <div className="muted" style={{ fontSize: 12 }}>{l.chapter}</div>}<strong>{l.title}</strong><div className="muted" style={{ fontSize: 12 }}>{[l.hasVideo ? "video" : null, l.questions ? `${l.questions}-question quiz` : "no quiz"].filter(Boolean).join(" · ")}</div></td>
              <td className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn sm" onClick={() => setEditing(l.id)}>Edit</button>
                <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Delete lesson "${l.title}"?`) && run(async () => { await api(`/training/lessons/${l.id}`, { method: "DELETE" }); data.reload(); })}>Delete</button>
              </td>
            </tr>
          ))}</tbody></table>
        ) : <Empty>No lessons yet. Add the first one.</Empty>}
      </div>
      {editing === "new" && <LessonForm courseId={id} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); data.reload(); }} />}
      {editing && editing !== "new" && full.data && <LessonForm key={editing} courseId={id} lesson={full.data} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); data.reload(); }} />}
    </>
  );
}
