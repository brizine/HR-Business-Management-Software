"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VISIT_FILE_MAX_BYTES, isImageType, isVideoType } from "@crewdesk/shared";
import { API_URL, api, fmtDateTime } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

export interface VisitFile { id: string; fileName: string; contentType: string; sizeBytes: number; caption: string | null; uploadedById: string | null; uploadedBy: string | null; createdAt: string }

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf,video/mp4,video/quicktime";
// Browsers can't show HEIC (except Safari), so those are listed as files to download.
const showable = (t: string) => isImageType(t) && t !== "image/heic" && t !== "image/heif";
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Big phone photos are shrunk to 2,400 px (JPEG) before upload so they're quick to send and open. */
async function shrink(file: File): Promise<File> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Photos and documents on a work order or to-do (like Homeworks' Photos / Documents): drop files or click to
 * add them (the crew and managers), see them in a grid, open one to view, caption, download or remove.
 */
export function VisitFiles({ visitId, base, canAdd, canManage, meId, onCount }: { visitId?: string; base?: string; canAdd: boolean; canManage: boolean; meId?: string; onCount?: (n: number) => void }) {
  // Work orders by default; `base` points it at another record (a to-do: "/todos/<id>").
  const path = base ?? `/visits/${visitId}`;
  const list = useApi<VisitFile[]>(`${path}/files`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const files = list.data ?? [];
  useEffect(() => { if (list.data) onCount?.(list.data.length); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const url = (f: VisitFile, download = false) => `${API_URL}${path}/files/${f.id}${download ? "?download=1" : ""}`;

  const add = async (picked: FileList | File[]) => {
    const all = [...picked];
    if (!all.length) return;
    setError(null);
    for (const [i, raw] of all.entries()) {
      setBusy(`Uploading ${i + 1} of ${all.length}…`);
      try {
        const f = await shrink(raw);
        if (f.size > VISIT_FILE_MAX_BYTES) throw new Error(`${raw.name} is over 25 MB`);
        const fd = new FormData();
        fd.append("file", f, f.name);
        await api(`${path}/files`, { method: "POST", body: fd });
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }
    setBusy(null);
    list.reload();
  };

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Photos &amp; documents{files.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {files.length}</span> : null}</h2>
        {canAdd && <button type="button" className="btn" disabled={!!busy} onClick={() => input.current?.click()}><Icon name="plus" size={14} /> Add</button>}
      </div>
      {canAdd && (
        <div className={`file-drop${over ? " over" : ""}`} onClick={() => input.current?.click()} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
          {busy ?? <>Drop photos, PDFs or short videos here, or <span className="linkbtn">choose files</span>. Up to 25 MB each.</>}
        </div>
      )}
      <ErrorBox error={error || list.error} />
      {files.length ? (
        <div className="file-grid">
          {files.map((f, i) => (
            <button key={f.id} type="button" className="file-tile" onClick={() => (f.contentType === "application/pdf" ? window.open(url(f), "_blank", "noopener") : setOpen(i))} title={f.caption ?? f.fileName}>
              {showable(f.contentType)
                ? <img src={url(f)} alt={f.caption ?? f.fileName} loading="lazy" />
                : <span className="file-icon"><Icon name={isVideoType(f.contentType) ? "monitor" : "clipboard"} size={28} /><span>{f.contentType === "application/pdf" ? "PDF" : isVideoType(f.contentType) ? "Video" : "Photo"}</span></span>}
              <span className="file-cap">{f.caption || f.fileName}</span>
            </button>
          ))}
        </div>
      ) : list.data && !canAdd ? <p className="muted" style={{ margin: 0 }}>No photos or documents.</p> : null}
      {open != null && files[open] && (
        <Viewer files={files} index={open} setIndex={setOpen} url={url} path={path}
          canEdit={canAdd} canDelete={(f) => canManage || f.uploadedById === meId} onChanged={() => list.reload()} />
      )}
    </div>
  );
}

function Viewer({ files, index, setIndex, url, path, canEdit, canDelete, onChanged }: {
  files: VisitFile[]; index: number; setIndex: (i: number | null) => void; url: (f: VisitFile, d?: boolean) => string; path: string;
  canEdit: boolean; canDelete: (f: VisitFile) => boolean; onChanged: () => void;
}) {
  const f = files[index];
  const [caption, setCaption] = useState(f.caption ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setCaption(f.caption ?? ""); setErr(null); }, [f.id, f.caption]);
  const close = useCallback(() => setIndex(null), [setIndex]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      if (e.key === "ArrowRight" && index < files.length - 1) setIndex(index + 1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [index, files.length, close, setIndex]);
  const save = async () => { try { await api(`${path}/files/${f.id}`, { method: "PATCH", body: { caption: caption.trim() || null } }); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const remove = async () => {
    if (!confirm(`Remove ${f.fileName}?`)) return;
    try { await api(`${path}/files/${f.id}`, { method: "DELETE" }); onChanged(); close(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} role="dialog" aria-label={f.fileName}>
      <div className="viewer">
        <div className="viewer-media">
          {index > 0 && <button type="button" className="viewer-nav prev" aria-label="Previous" onClick={() => setIndex(index - 1)}><Icon name="left" size={22} /></button>}
          {showable(f.contentType) ? <img src={url(f)} alt={f.caption ?? f.fileName} />
            : isVideoType(f.contentType) ? <video src={url(f)} controls playsInline />
            : <a className="btn" href={url(f, true)}>Download {f.fileName}</a>}
          {index < files.length - 1 && <button type="button" className="viewer-nav next" aria-label="Next" onClick={() => setIndex(index + 1)}><Icon name="right" size={22} /></button>}
        </div>
        <div className="viewer-side stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong style={{ overflowWrap: "anywhere" }}>{f.fileName}</strong>
            <button type="button" className="cal-icon-btn" aria-label="Close" onClick={close}><Icon name="close" size={18} /></button>
          </div>
          <span className="muted">{[f.uploadedBy, fmtDateTime(f.createdAt), size(f.sizeBytes)].filter(Boolean).join(" · ")}</span>
          {canEdit ? (
            <label>Caption<input value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== (f.caption ?? "") && save()} placeholder="Before, after, problem spot…" /></label>
          ) : f.caption ? <p style={{ margin: 0 }}>{f.caption}</p> : null}
          <div className="row">
            <a className="btn" href={url(f, true)}><Icon name="download" size={14} /> Download</a>
            {canDelete(f) && <button type="button" className="btn danger" onClick={remove}>Remove</button>}
          </div>
          <span className="muted">{index + 1} of {files.length}</span>
          {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
        </div>
      </div>
    </div>
  );
}
