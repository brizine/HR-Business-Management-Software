"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";
import { MarkdownLite } from "./markdown-lite";

type Guide = { markdown: string; custom: boolean; standardChanged: boolean };

/**
 * Layout Editor: the owner edits the company's user manual (Help → User Manual, and what the help
 * assistant answers from). Blank or "Reset" goes back to Crewdesk's standard manual.
 */
export function ManualEditorCard() {
  const guide = useApi<Guide>("/help/guide");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [view, setView] = useState<"edit" | "preview" | "standard">("edit");
  const [standard, setStandard] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (guide.data) setText(guide.data.markdown); }, [guide.data]);
  const dirty = !!guide.data && text !== guide.data.markdown;

  const showStandard = () => run(async () => {
    if (standard == null) setStandard((await api<{ markdown: string }>("/help/guide/standard")).markdown);
    setView("standard");
  });
  const save = (markdown: string | null) => run(async () => {
    guide.setData(await api<Guide>("/help/guide", { method: "PUT", body: { markdown } }));
    setSaved(true);
  });

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>User Manual</h2>
        <button className="btn" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit the user manual"}</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        What everyone sees under <strong>Help → User Manual</strong>, and what the help assistant answers from. Add your own
        company procedures (who to call, where keys are kept, your rules) or change anything. {guide.data?.custom ? "You're using your company's edited copy." : "You're using Crewdesk's standard manual."}
      </p>
      {guide.data?.standardChanged && (
        <p style={{ margin: 0 }} role="status">
          ⚠ Crewdesk&apos;s standard manual has been updated (usually for new features) since you last saved yours.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); showStandard(); }}>View the standard manual</a> to copy in what&apos;s new, or reset to it.
        </p>
      )}
      {open && guide.data && (
        <>
          <div className="row" role="tablist" style={{ gap: 6 }}>
            {(["edit", "preview"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={`btn sm ${view === v ? "primary" : ""}`} onClick={() => setView(v)}>{v === "edit" ? "Edit" : "Preview"}</button>
            ))}
            <button type="button" role="tab" aria-selected={view === "standard"} className={`btn sm ${view === "standard" ? "primary" : ""}`} onClick={showStandard}>Standard manual</button>
          </div>
          {view === "edit" && (
            <>
              <textarea value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} rows={28} spellCheck
                style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.5 }} aria-label="User manual text" />
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Formatting: a line starting with <code>## </code> starts a section (it appears in the manual&apos;s contents), <code>- </code> makes a bullet,{" "}
                <code>1. </code> a numbered step, and <code>**words**</code> are bold. Leave a blank line between paragraphs.
              </p>
            </>
          )}
          {view === "preview" && <div className="manual-preview"><MarkdownLite text={text} className="help-answer" /></div>}
          {view === "standard" && standard != null && (
            <>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Crewdesk&apos;s standard manual (read only). Copy any part into your copy on the Edit tab.</p>
              <textarea readOnly value={standard} rows={28} style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.5 }} aria-label="Standard manual" />
            </>
          )}
          <ErrorBox error={error} />
          <div className="row">
            <button className="btn primary" disabled={busy || !dirty} onClick={() => save(text)}>Save the manual</button>
            {guide.data.custom && (
              <button className="btn danger" disabled={busy} onClick={() => confirm("Throw away your company's edits and use Crewdesk's standard manual again?") && save(null)}>Reset to the standard manual</button>
            )}
            {dirty && <button className="btn" disabled={busy} onClick={() => setText(guide.data!.markdown)}>Undo changes</button>}
            {saved && !dirty && <span className="muted" role="status">Saved. Help shows it now.</span>}
          </div>
        </>
      )}
    </div>
  );
}
