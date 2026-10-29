"use client";
import { useRef } from "react";
import { API_URL, api, download, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { Badge, ErrorBox } from "./ui";

const ACTION_HINT: Record<string, string> = {
  upload: "Upload a photo or PDF",
  sign: "Read and sign",
};

/** Opens a document in a new tab through a short-lived view link (works for images and PDFs). */
export async function viewDocument(documentId: string) {
  const { path } = await api(`/documents/${documentId}/link`, { method: "POST" });
  window.open(API_URL + path, "_blank", "noopener");
}

/**
 * One onboarding task. "self" is the new hire doing their own tasks (upload,
 * sign or check off); "manager" can see progress and check anything off.
 */
export function OnboardingTask({ task, mode, onChange }: { task: any; mode: "self" | "manager"; onChange: () => void }) {
  const { me } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const overdue = !task.completedAt && task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);
  const complete = () => run(async () => { await api(`/onboarding/tasks/${task.id}/complete`, { method: "POST" }); onChange(); });

  let actions = null;
  if (!task.completedAt) {
    if (mode === "self" && task.assignee === "employee") {
      if (task.action === "upload") {
        actions = (
          <>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append("file", file);
                run(async () => { await api(`/onboarding/tasks/${task.id}/upload`, { body: fd }); onChange(); });
              }} />
            <button className="btn sm primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading…" : "Upload"}</button>
          </>
        );
      } else if (task.action === "sign" && task.document) {
        actions = (
          <>
            <button className="btn sm" onClick={() => run(() => viewDocument(task.document.id))}>Read</button>
            <button className="btn sm primary" disabled={busy} onClick={() => {
              const signedName = prompt(`Type your full name to sign "${task.document.name}"`, me ? `${me.user.firstName} ${me.user.lastName}` : "");
              if (signedName) run(async () => { await api(`/documents/${task.document.id}/sign`, { body: { signedName } }); onChange(); });
            }}>Sign</button>
          </>
        );
      } else {
        actions = <button className="btn sm primary" disabled={busy} onClick={complete}>Done</button>;
      }
    } else if (mode === "self") {
      actions = <span className="muted">Waiting on your {task.assignee}</span>;
    } else {
      actions = (
        <button className="btn sm" disabled={busy} onClick={complete} title={task.action !== "none" ? "Use this if you received a paper copy" : ""}>
          {task.action === "none" ? "Mark done" : "Mark done (paper copy)"}
        </button>
      );
    }
  }

  return (
    <tr>
      <td>
        <strong style={{ fontWeight: task.completedAt ? 400 : 600 }}>{task.title}</strong>
        <div className="muted">
          {task.assignee !== "employee" && mode === "manager" ? `For ${task.assignee} · ` : ""}
          {task.action !== "none" && !task.completedAt ? `${ACTION_HINT[task.action]} · ` : ""}
          due {fmtDate(task.dueDate)}
          {task.description && <> · {task.description}</>}
        </div>
        {task.document && task.completedAt && (
          <a href="#" onClick={(e) => { e.preventDefault(); download(`/documents/${task.document.id}/download`, task.document.name); }}>{task.document.name}</a>
        )}
        <ErrorBox error={error} />
      </td>
      <td style={{ width: 1, whiteSpace: "nowrap", textAlign: "right" }}>
        {task.completedAt ? <Badge value="completed" /> : overdue ? <Badge value="overdue" /> : null}{" "}
        {actions}
      </td>
    </tr>
  );
}
