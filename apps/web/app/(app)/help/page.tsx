"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";

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

/** Bold (**text**) inside a line. */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** The answers use simple Markdown: paragraphs, numbered and bulleted lists, bold. */
function Answer({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (numbered || bullet) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((numbered ?? bullet)![1]);
    } else if (!line) {
      flush();
    } else {
      flush();
      blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  return <div className="help-answer">{blocks}</div>;
}

export default function Help() {
  const { me } = useAuth();
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
      <PageHead title="Help" sub="Ask how to do anything in Crewdesk. Answers come from an AI assistant that knows the Crewdesk guide.">
        {messages.length > 0 && <button className="btn" onClick={() => { setMessages([]); setError(null); }}>New conversation</button>}
      </PageHead>
      {unavailable && (
        <div className="card">
          <h2>Help Assistant Not Set Up Yet</h2>
          <p style={{ margin: 0 }}>
            {me?.user.role === "owner" || me?.user.role === "admin"
              ? "To turn it on, add an Anthropic API key as ANTHROPIC_API_KEY in the server's environment variables (on SiteGround: Node.js → Environment variables), then Save and deploy."
              : "Ask your Crewdesk admin to turn it on."}
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
    </>
  );
}
