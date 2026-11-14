"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { MarkdownLite, slug } from "@/components/markdown-lite";

type Msg = { role: "user" | "assistant"; content: string };
const STORE = "crewdesk-help-chat";
const SUGGESTIONS = [
  "How do I schedule someone for a whole week?",
  "How do I fix a missed clock-in?",
  "How do I request time off?",
  "How do I set up an oil change reminder every 5,000 miles?",
  "How do I change who gets notifications?",
  "How do I add a new employee?",
];

function Answer({ text }: { text: string }) {
  return <MarkdownLite text={text} className="help-answer" />;
}

/** The whole user manual: contents on the left, sections on the right, with search. */
function Manual() {
  const guide = useApi<{ markdown: string }>("/help/guide");
  const [q, setQ] = useState("");
  const sections = useMemo(() => {
    const md = guide.data?.markdown ?? "";
    return md.split(/\n(?=## )/).filter((s) => s.startsWith("## ")).map((s) => {
      const [first, ...rest] = s.split("\n");
      return { title: first.replace(/^##\s+/, ""), body: rest.join("\n") };
    });
  }, [guide.data]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? sections.filter((s) => `${s.title}\n${s.body}`.toLowerCase().includes(needle)) : sections;
  if (!guide.data) return <ErrorBox error={guide.error} />;
  return (
    <div className="manual" data-lkeep="">
      <nav className="card manual-toc" aria-label="Manual contents">
        <label>Search the manual<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. overtime, QR, holiday" /></label>
        <ol>
          {shown.map((s) => <li key={s.title}><a href={`#${slug(s.title)}`}>{s.title}</a></li>)}
        </ol>
        {needle && !shown.length && <p className="muted" style={{ margin: 0 }}>Nothing matches. Try the assistant.</p>}
      </nav>
      <div className="manual-body">
        {shown.map((s) => (
          <section key={s.title} className="card" id={slug(s.title)}>
            <h2>{s.title}</h2>
            <MarkdownLite text={s.body} className="help-answer" />
          </section>
        ))}
      </div>
    </div>
  );
}

function HelpPage() {
  const { me } = useAuth();
  const [tab, setTab] = useState<"ask" | "manual">(useSearchParams().get("tab") === "manual" ? "manual" : "ask");
  const status = useApi<{ available: boolean }>("/help/status");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Keep the conversation while moving around Crewdesk in this tab (this browser only).
  useEffect(() => {
    try { const saved = sessionStorage.getItem(STORE); if (saved) setMessages(JSON.parse(saved)); } catch { /* storage off */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(messages)); } catch { /* storage off */ }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      // The last 20 messages are plenty of context for a help chat.
      const { answer } = await api<{ answer: string }>("/help/ask", { body: { messages: next.slice(-20) } });
      setMessages([...next, { role: "assistant", content: answer }]);
    } catch (e) {
      setError((e as Error).message);
      setMessages(messages); // take the question back so it can be asked again
      setDraft(q);
    } finally {
      setBusy(false);
    }
  };

  const unavailable = status.data && !status.data.available;
  return (
    <>
      <PageHead title="Help" sub="Ask the assistant how to do anything in Crewdesk, or browse the user manual.">
        <div className="row" role="tablist" style={{ gap: 6 }}>
          <button type="button" role="tab" aria-selected={tab === "ask"} className={`btn ${tab === "ask" ? "primary" : ""}`} onClick={() => setTab("ask")}>Ask the Assistant</button>
          <button type="button" role="tab" aria-selected={tab === "manual"} className={`btn ${tab === "manual" ? "primary" : ""}`} onClick={() => setTab("manual")}>User Manual</button>
        </div>
        {tab === "ask" && messages.length > 0 && <button className="btn" onClick={() => { setMessages([]); setError(null); }}>New conversation</button>}
      </PageHead>
      {tab === "manual" ? <Manual /> : <>
      {unavailable && (
        <div className="card">
          <h2>Help Assistant Not Set Up Yet</h2>
          <p style={{ margin: 0 }}>
            {me?.user.role === "owner" || me?.user.role === "admin"
              ? "To turn it on, add an Anthropic API key as ANTHROPIC_API_KEY in the server's environment variables (on SiteGround: Node.js → Environment variables), then Save and deploy."
              : "Ask your Crewdesk admin to turn it on."}
            {" "}Meanwhile, the <a href="#" onClick={(e) => { e.preventDefault(); setTab("manual"); }}>User Manual</a> has everything the assistant knows.
          </p>
        </div>
      )}
      <div className="card help-chat">
        {messages.length === 0 ? (
          <div className="stack">
            <p style={{ margin: 0 }}>Hi {me?.user.firstName}! What would you like to do? For example:</p>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {SUGGESTIONS.map((s) => <button key={s} className="btn sm" disabled={busy || !!unavailable} onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>
        ) : (
          <div className="help-messages" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={`help-msg ${m.role}`}>
                {m.role === "user" ? <p>{m.content}</p> : <Answer text={m.content} />}
              </div>
            ))}
            {busy && <div className="help-msg assistant muted">Thinking…</div>}
            <div ref={end} />
          </div>
        )}
        <ErrorBox error={error} />
        <form className="help-input" onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={4000} disabled={!!unavailable}
            placeholder="Type a question, e.g. How do I copy last week's schedule?"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }} />
          <button className="btn primary" disabled={busy || !draft.trim() || !!unavailable}>{busy ? "Asking…" : "Ask"}</button>
        </form>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          The assistant explains how Crewdesk works; it can&apos;t see or change your company&apos;s records. It can make mistakes, so check anything important.
        </p>
      </div>
      </>}
    </>
  );
}

export default function Help() {
  return <Suspense><HelpPage /></Suspense>;
}
