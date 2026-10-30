"use client";
import { useRef, useState } from "react";
import { API_URL, api } from "@/lib/api";

/** An employee's photo, or their initials in a circle when there isn't one. */
export function Avatar({ e, size = 32 }: { e: any; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = `${e.firstName?.[0] ?? ""}${e.lastName?.[0] ?? ""}`.toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (e.hasPhoto && !broken) {
    const v = e.photoUpdatedAt ? `?v=${encodeURIComponent(e.photoUpdatedAt)}` : "";
    return <img className="avatar" style={style} src={`${API_URL}/employees/${e.id}/photo${v}`} alt={`${e.firstName} ${e.lastName}`} onError={() => setBroken(true)} />;
  }
  return <span className="avatar avatar-initials" style={style} aria-hidden="true">{initials}</span>;
}

/**
 * Shrinks a photo in the browser before upload (longest side 800px, JPEG), so a 6 MB phone
 * picture becomes ~100 KB. Browsers apply the photo's rotation (EXIF) when decoding it.
 */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that photo"))), "image/jpeg", 0.85));
}

/** Large photo with Add / Change / Remove, for the profile page. */
export function PhotoEditor({ e, canEdit, onChange }: { e: any; canEdit: boolean; onChange: (updated: any) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", await shrink(file), "photo.jpg");
      onChange(await api(`/employees/${e.id}/photo`, { method: "PUT", body: fd }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="photo-editor">
      <Avatar e={e} size={72} />
      {canEdit && (
        <div className="photo-actions noprint">
          <input ref={input} type="file" accept="image/*" hidden onChange={(ev) => ev.target.files?.[0] && upload(ev.target.files[0])} />
          <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : e.hasPhoto ? "Change photo" : "Add photo"}</button>
          {e.hasPhoto && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => confirm("Remove this photo?") && api(`/employees/${e.id}/photo`, { method: "DELETE" }).then(onChange, (err) => setError(err.message))}>Remove</button>
          )}
          {error && <span className="error-text" role="alert">{error}</span>}
        </div>
      )}
    </div>
  );
}
