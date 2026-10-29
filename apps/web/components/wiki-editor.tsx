"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { WIKI_LEVELS, WIKI_LEVEL_LABELS, hasRole, type Role, type WikiLevel } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";
import { Markdown } from "./markdown";
import type { WikiListItem } from "./wiki";

const HELP = "# Heading · ## Smaller heading · **bold** · *italic* · - bullet list · 1. numbered list · [link text](https://…) · | table | columns |";

/** Create or edit a page. Only admins see the access, pin and location settings when editing. */
export function WikiEditor({ page, parentId }: { page?: any; parentId?: string | null }) {
  const { me } = useAuth();
  const router = useRouter();
  const pages = useApi<WikiListItem[]>("/wiki/pages");
  const role = (me?.user.role ?? "employee") as Role;
  const admin = hasRole(role, "admin");
  const creating = !page;
  const [title, setTitle] = useState(page?.title ?? "");
  const [body, setBody] = useState(page?.body ?? "");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [viewMin, setViewMin] = useState<WikiLevel>(page?.viewMin ?? "employee");
  const [editMin, setEditMin] = useState<WikiLevel>(page?.editMin ?? (admin ? "admin" : role === "manager" ? "manager" : "employee"));
  const [parent, setParent] = useState<string>(page?.parentId ?? parentId ?? "");
  const [pinned, setPinned] = useState<boolean>(page?.pinned ?? false);
  const [notify, setNotify] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();

  // Levels this person may choose: never above their own role.
  const allowed = WIKI_LEVELS.filter((l) => hasRole(role, l as Role));
  const canSetAccess = creating || admin;
  // Pages this one can be placed under (not itself or its own sub-pages).
  const descendants = new Set<string>();
  if (page) {
    const walk = (id: string) => pages.data?.filter((p) => p.parentId === id).forEach((p) => { descendants.add(p.id); walk(p.id); });
    descendants.add(page.id);
    walk(page.id);
  }

  const save = () => run(async () => {
    const access = canSetAccess ? { viewMin, editMin } : {};
    const placement = creating || admin ? { parentId: parent || null, ...(admin ? { pinned } : {}) } : {};
    const saved = creating
      ? await api("/wiki/pages", { body: { title, body, ...access, ...placement, notify, note: note || undefined } })
      : await api(`/wiki/pages/${page.id}`, { method: "PATCH", body: { title, body, ...access, ...placement, notify, note: note || undefined, baseUpdatedAt: page.updatedAt } });
    router.push(`/wiki/${saved.id}`);
  });

  return (
    <form className="stack wiki-editor" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
      <div className="card" style={{ padding: 0 }}>
        <div className="tabs" role="tablist" aria-label="Editor">
          <button type="button" role="tab" id="tab-write" aria-controls="panel-write" aria-selected={tab === "write"} onClick={() => setTab("write")}>Write</button>
          <button type="button" role="tab" id="tab-preview" aria-controls="panel-preview" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Preview</button>
        </div>
        <div style={{ padding: 12 }}>
          {tab === "write" ? (
            <div id="panel-write" role="tabpanel" aria-labelledby="tab-write">
              <label htmlFor="wiki-body" className="sr-only">Page text</label>
              <textarea id="wiki-body" value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="wiki-help" />
              <p id="wiki-help" className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Formatting: {HELP}</p>
            </div>
          ) : (
            <div id="panel-preview" role="tabpanel" aria-labelledby="tab-preview">{body.trim() ? <Markdown>{body}</Markdown> : <p className="muted">Nothing to preview yet.</p>}</div>
          )}
        </div>
      </div>

      {(creating || admin) && (
        <fieldset className="card stack" style={{ margin: 0 }}>
          <legend style={{ fontWeight: 600, padding: "0 4px" }}>Where it goes and who can use it</legend>
          <div className="formgrid">
            <label>Inside page
              <select value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">Top level</option>
                {pages.data?.filter((p) => !descendants.has(p.id)).sort((a, b) => a.title.localeCompare(b.title)).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </label>
            <label>Who can see it
              <select value={viewMin} disabled={!canSetAccess} onChange={(e) => {
                const v = e.target.value as WikiLevel;
                setViewMin(v);
                if (!hasRole(editMin as Role, v as Role)) setEditMin(v);
              }}>
                {allowed.map((l) => <option key={l} value={l}>{WIKI_LEVEL_LABELS[l]}</option>)}
              </select>
            </label>
            <label>Who can edit it
              <select value={editMin} disabled={!canSetAccess} onChange={(e) => setEditMin(e.target.value as WikiLevel)}>
                {allowed.filter((l) => hasRole(l as Role, viewMin as Role)).map((l) => <option key={l} value={l}>{WIKI_LEVEL_LABELS[l]}</option>)}
              </select>
            </label>
          </div>
          {admin && <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top of the wiki</label>}
        </fieldset>
      )}

      <div className="formgrid">
        <label>What changed? (optional, shown in the history)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Updated holiday dates" /></label>
      </div>
      <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify everyone who can see this page</label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !title.trim()}>{creating ? "Publish page" : "Save changes"}</button>
        <button type="button" className="btn" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
