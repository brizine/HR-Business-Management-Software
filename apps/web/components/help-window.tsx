"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/icons";
import { MarkdownLite, slug } from "@/components/markdown-lite";

/**
 * The Help window: a messenger that pops up from the Help button and stays put while you move
 * around Crewdesk. Laid out like the messenger Homeworks uses for its help:
 *   - Home: the first thing shown, with a greeting, "Ask a question" and the User Manual's search
 *     and popular topics (there is no Home tab: pressing Help always starts here);
 *   - Help (their Messages): conversations with the assistant, which answers from the User Manual;
 *   - User Manual (their Help): the manual's sections, with search.
 * Conversations are kept in this browser; the window's place is kept for the tab's session.
 */

/* ───────────── What's shown ───────────── */

type Screen =
  | { at: "home" }
  | { at: "help" }
  | { at: "chat"; id: string }
  | { at: "manual"; q?: string }
  | { at: "article"; title: string; part?: string };
type Msg = { role: "user" | "assistant"; content: string; sources?: string[]; at: number; local?: boolean };
type Conversation = { id: string; startedAt: number; updatedAt: number; messages: Msg[] };
type Section = { title: string; body: string; lead: string; parts: string[] };
type Hit = { section: Section; part: string; snippet: string; score: number };

const WINDOW_KEY = "crewdesk-help-window";
const chatsKey = (userId: string) => `crewdesk-help-chats:${userId}`;
const read = <T,>(store: Storage, key: string, fallback: T): T => { try { const v = store.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const write = (store: Storage, key: string, value: unknown) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* private window, or full */ } };

const SUGGESTIONS = [
  "How do I add a new customer?",
  "How do I schedule a work order?",
  "How do I move work on the dispatch board?",
  "How do I send an invoice?",
  "How do I fix someone's time punches?",
];
/** The manual sections offered on the Home screen, in this order, when the manual has them. */
const POPULAR = ["Finding your way: Operations and Team", "Customers & Properties", "Work orders", "Dispatch boards", "Time Clock", "Phone app"];

/* ───────────── The manual ───────────── */

const plain = (md: string) => md.replace(/\*\*|`/g, "").replace(/^[-*•]\s+|^#+\s+|^\d+[.)]\s+/gm, "").replace(/\s+/g, " ").trim();

/** The manual as sections (its "## " headings), each cut into parts: a top-level bullet or sub-heading with what hangs under it. */
export function manualSections(markdown: string): Section[] {
  return markdown.split(/\n(?=## )/).filter((s) => s.startsWith("## ")).map((s) => {
    const [first, ...rest] = s.split("\n");
    const body = rest.join("\n").trim();
    // A top-level bullet, a sub-heading or a new paragraph starts a part; wrapped and indented lines stay with theirs.
    const parts: string[] = [];
    let blank = true;
    for (const line of body.split("\n")) {
      if (!parts.length || /^(- |### |\d+[.)] )/.test(line) || (blank && /^\S/.test(line))) parts.push(line);
      else parts[parts.length - 1] += `\n${line}`;
      blank = !line.trim();
    }
    const lead = plain(body.split(/\n\s*\n/)[0] ?? "");
    return { title: first.replace(/^##\s+/, "").trim(), body, lead: lead.length > 120 ? `${lead.slice(0, 117).trimEnd()}…` : lead, parts: parts.map((p) => p.trim()).filter(Boolean) };
  });
}

/** A word's root, near enough for matching: "missed" and "missing" both find "miss". */
const root = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);

/**
 * The parts of the manual closest to what was typed, best first. A part needs most of the words
 * (all of them for one or two; a question's worth can miss a couple), in any form ("missed" finds
 * "miss"). Words in the section's title and in a part's opening count most.
 */
export function searchManual(sections: Section[], q: string, limit = 12): Hit[] {
  const words = [...new Set(q.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(root))];
  if (!words.length) return [];
  const need = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  const hits: Hit[] = [];
  for (const section of sections) {
    const title = section.title.toLowerCase();
    for (const part of section.parts.length ? section.parts : [section.body]) {
      const text = plain(part), low = text.toLowerCase();
      const inText = words.filter((w) => low.includes(w));
      const found = words.filter((w) => low.includes(w) || title.includes(w)).length;
      if (!inText.length || found < need) continue;
      const count = inText.reduce((n, w) => n + Math.min(4, low.split(w).length - 1), 0);
      const at = Math.max(0, Math.min(...inText.map((w) => low.indexOf(w))) - 40);
      hits.push({
        section, part,
        snippet: `${at > 0 ? "…" : ""}${text.slice(at, at + 150).trim()}${text.length > at + 150 ? "…" : ""}`,
        score: found * 10 + count + words.filter((w) => title.includes(w)).length * 5 + words.filter((w) => low.slice(0, 60).includes(w)).length * 3,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
const STOP = new Set(["how", "do", "does", "the", "to", "an", "is", "in", "on", "of", "for", "and", "or", "can", "what", "where", "when", "my", "it", "with", "that", "this", "you", "are", "me", "we", "our", "from", "at", "be", "get", "up", "if"]);

/* ───────────── The Help button's side of it ───────────── */

const HelpContext = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} });
/** For the Help button: whether the window is open, and the press that opens (at Home) or closes it. */
export const useHelp = () => useContext(HelpContext);

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "Just now" : m < 60 ? `${m}m ago` : m < 24 * 60 ? `${Math.round(m / 60)}h ago` : m < 7 * 24 * 60 ? `${Math.round(m / 1440)}d ago` : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Wraps the app: the Help button anywhere inside can open the window, which is drawn here once, over every page. */
export function HelpProvider({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<Screen[]>([{ at: "home" }]);
  const [wide, setWide] = useState(false);
  const restored = useRef(false);
  // Where the window was, through a page reload.
  useEffect(() => {
    const was = read<{ open?: boolean; stack?: Screen[]; wide?: boolean } | null>(sessionStorage, WINDOW_KEY, null);
    if (was?.stack?.length) setStack(was.stack);
    if (was?.wide) setWide(true);
    if (was?.open) setOpen(true);
    restored.current = true;
  }, []);
  useEffect(() => { if (restored.current) write(sessionStorage, WINDOW_KEY, { open, stack, wide }); }, [open, stack, wide]);
  // Pressing Help starts at Home, every time.
  const toggle = useCallback(() => setOpen((o) => { if (!o) { setStack([{ at: "home" }]); setWide(false); } return !o; }), []);
  const value = useMemo(() => ({ open, toggle }), [open, toggle]);
  return (
    <HelpContext.Provider value={value}>
      {children}
      {open && me && <HelpWindow stack={stack} setStack={setStack} wide={wide} setWide={setWide} onClose={() => setOpen(false)} />}
    </HelpContext.Provider>
  );
}

/* ───────────── The window ───────────── */

function HelpWindow({ stack, setStack, wide, setWide, onClose }: { stack: Screen[]; setStack: (s: Screen[]) => void; wide: boolean; setWide: (w: boolean) => void; onClose: () => void }) {
  const { me } = useAuth();
  const userId = me!.user.id;
  const screen = stack[stack.length - 1] ?? { at: "home" as const };
  const go = (...next: Screen[]) => setStack([...stack, ...next]);
  const back = () => setStack(stack.length > 1 ? stack.slice(0, -1) : [{ at: "home" }]);
  const tab = (at: "help" | "manual") => setStack([{ at: "home" }, { at }]);

  // The manual, and whether the assistant is turned on (asked once per opening).
  const [sections, setSections] = useState<Section[] | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ markdown: string }>("/help/guide").then((g) => setSections(manualSections(g.markdown)), (e) => setManualError((e as Error).message));
    api<{ available: boolean }>("/help/status").then((s) => setAi(s.available), () => setAi(false));
  }, []);

  // Conversations with the assistant: this person's, in this browser.
  const [chats, setChats] = useState<Conversation[]>(() => read<Conversation[]>(localStorage, chatsKey(userId), []));
  const saveChats = (next: Conversation[]) => { const kept = [...next].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20); setChats(kept); write(localStorage, chatsKey(userId), kept); };
  const newChat = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const article = (title: string, part?: string) => go({ at: "article", title, part });
  const tabs = screen.at !== "chat" && screen.at !== "article";
  return (
    <aside className={`hp${wide && screen.at === "article" ? " wide" : ""}`} role="dialog" aria-label="Help">
      {screen.at === "home" && (
        <Home me={me!} chats={chats} sections={sections} onClose={onClose}
          onAsk={() => setStack([{ at: "home" }, { at: "help" }, { at: "chat", id: newChat() }])}
          onOpenChat={(id) => setStack([{ at: "home" }, { at: "help" }, { at: "chat", id }])}
          onSearch={(q) => setStack([{ at: "home" }, { at: "manual", q }])}
          onArticle={(title) => setStack([{ at: "home" }, { at: "manual" }, { at: "article", title }])} />
      )}
      {screen.at === "help" && (
        <>
          <Head title="Help" onBack={back} onClose={onClose} />
          <ChatList chats={chats} onOpen={(id) => go({ at: "chat", id })} onNew={() => go({ at: "chat", id: newChat() })} />
        </>
      )}
      {screen.at === "chat" && (
        <Chat key={screen.id} id={screen.id} chats={chats} saveChats={saveChats} ai={ai} sections={sections} firstName={me!.user.firstName} admin={me!.user.role === "owner" || me!.user.role === "admin"}
          onBack={back} onClose={onClose} onSource={article} />
      )}
      {screen.at === "manual" && (
        <>
          <Head title="User Manual" onBack={back} onClose={onClose} />
          {/* What's typed stays with the screen, so it's still there on the way back from an article. */}
          <Manual sections={sections} error={manualError} q={screen.q ?? ""} setQ={(q) => setStack([...stack.slice(0, -1), { at: "manual", q }])} onArticle={article} />
        </>
      )}
      {screen.at === "article" && (
        <>
          <Head title="User Manual" onBack={back} onClose={onClose}>
            <button type="button" className="hp-icon" aria-label={wide ? "Make the window smaller" : "Make the window larger"} title={wide ? "Smaller" : "Larger"} onClick={() => setWide(!wide)}><Icon name={wide ? "minimize" : "maximize"} size={16} /></button>
          </Head>
          <Article section={sections?.find((s) => s.title === screen.title) ?? null} loading={!sections && !manualError} part={screen.part} />
        </>
      )}
      {tabs && (
        <nav className="hp-tabs" aria-label="Help sections">
          <button type="button" className={screen.at === "help" ? "on" : ""} aria-current={screen.at === "help" ? "page" : undefined} onClick={() => tab("help")}><Icon name="messages" size={22} /><span>Help</span></button>
          <button type="button" className={screen.at === "manual" ? "on" : ""} aria-current={screen.at === "manual" ? "page" : undefined} onClick={() => tab("manual")}><Icon name="book" size={22} /><span>User Manual</span></button>
        </nav>
      )}
    </aside>
  );
}

function Head({ title, onBack, onClose, children }: { title: React.ReactNode; onBack: () => void; onClose: () => void; children?: React.ReactNode }) {
  return (
    <header className="hp-head">
      <button type="button" className="hp-icon" aria-label="Back" onClick={onBack}><Icon name="chevronLeft" size={20} /></button>
      <div className="hp-title">{title}</div>
      {children}
      <button type="button" className="hp-icon" aria-label="Close Help" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
  );
}

const Bot = ({ size = 32 }: { size?: number }) => <span className="hp-bot" style={{ width: size, height: size }} aria-hidden="true"><Icon name="spark" size={Math.round(size * 0.5)} /></span>;

/* ───────────── Home ───────────── */

function Home({ me, chats, sections, onClose, onAsk, onOpenChat, onSearch, onArticle }: {
  me: NonNullable<ReturnType<typeof useAuth>["me"]>; chats: Conversation[]; sections: Section[] | null; onClose: () => void;
  onAsk: () => void; onOpenChat: (id: string) => void; onSearch: (q: string) => void; onArticle: (title: string) => void;
}) {
  const [q, setQ] = useState("");
  const recent = chats[0];
  const last = recent?.messages[recent.messages.length - 1];
  const topics = sections ? POPULAR.filter((t) => sections.some((s) => s.title === t)).concat(sections.map((s) => s.title).filter((t) => !POPULAR.includes(t))).slice(0, 4) : [];
  const version = me.company.logoUpdatedAt ? `&v=${encodeURIComponent(me.company.logoUpdatedAt)}` : "";
  return (
    <div className="hp-home">
      <div className="hp-hero">
        <div className="hp-hero-top">
          {me.company.hasLogo ? <span className="hp-logo"><img src={`${API_URL}/company/logo?size=small${version}`} alt={me.company.name} /></span> : <span className="hp-company">{me.company.name}</span>}
          <button type="button" className="hp-icon light" aria-label="Close Help" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <h2><span>Hi {me.user.firstName} 👋</span>How can we help?</h2>
      </div>
      <div className="hp-cards">
        {recent && last && (
          <button type="button" className="hp-card hp-recent" onClick={() => onOpenChat(recent.id)}>
            <span className="hp-card-label">Recent message</span>
            <span className="hp-row">
              <Bot />
              <span className="hp-row-text"><span className="hp-clip">{plain(last.content)}</span><span className="muted">Crewdesk Assistant · {ago(recent.updatedAt)}</span></span>
              <Icon name="chevronRight" size={16} />
            </span>
          </button>
        )}
        <button type="button" className="hp-card hp-ask" onClick={onAsk}>
          <span className="hp-row-text"><strong>Ask a question</strong><span className="muted">The assistant answers right away</span></span>
          <Icon name="send" size={18} />
        </button>
        <div className="hp-card hp-find">
          <form onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()); }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the User Manual" aria-label="Search the User Manual" />
            <button type="submit" className="hp-icon" aria-label="Search"><Icon name="search" size={16} /></button>
          </form>
          {topics.map((t) => (
            <button key={t} type="button" className="hp-topic" onClick={() => onArticle(t)}><span>{t}</span><Icon name="chevronRight" size={16} /></button>
          ))}
          {!sections && <span className="muted hp-pad">Loading the manual…</span>}
        </div>
      </div>
    </div>
  );
}

/* ───────────── Help: conversations with the assistant ───────────── */

function ChatList({ chats, onOpen, onNew }: { chats: Conversation[]; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <div className="hp-body hp-list">
      {chats.length === 0 ? (
        <div className="hp-empty">
          <Icon name="messages" size={34} />
          <strong>No messages yet</strong>
          <span className="muted">Your questions and the assistant&apos;s answers will show here.</span>
        </div>
      ) : chats.map((c) => {
        const last = c.messages[c.messages.length - 1];
        return (
          <button key={c.id} type="button" className="hp-conv" onClick={() => onOpen(c.id)}>
            <Bot size={36} />
            <span className="hp-row-text">
              <span className="hp-clip"><strong>{c.messages.find((m) => m.role === "user")?.content ?? "New question"}</strong></span>
              <span className="hp-clip muted">{last ? plain(last.content) : ""}</span>
            </span>
            <span className="hp-when muted">{ago(c.updatedAt)}</span>
          </button>
        );
      })}
      <div className="hp-new"><button type="button" className="hp-pill" onClick={onNew}>Ask a question <Icon name="send" size={15} /></button></div>
    </div>
  );
}

function Chat({ id, chats, saveChats, ai, sections, firstName, admin, onBack, onClose, onSource }: {
  id: string; chats: Conversation[]; saveChats: (c: Conversation[]) => void; ai: boolean | null; sections: Section[] | null; firstName: string; admin: boolean;
  onBack: () => void; onClose: () => void; onSource: (title: string, part?: string) => void;
}) {
  const conv = chats.find((c) => c.id === id);
  const messages = conv?.messages ?? [];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, busy]);
  useEffect(() => { box.current?.focus(); }, []);

  const store = (list: Msg[]) => {
    const now = Date.now();
    saveChats([{ id, startedAt: conv?.startedAt ?? now, updatedAt: now, messages: list.slice(-60) }, ...chats.filter((c) => c.id !== id)]);
  };
  /** Without the assistant: the closest parts of the manual, as an answer. */
  const fromManual = (q: string): Msg => {
    const hits = sections ? searchManual(sections, q, 3) : [];
    if (!hits.length) return { role: "assistant", local: true, at: Date.now(), content: "I couldn't find that in the User Manual. Try other words, or open **User Manual** to look through its sections." };
    return { role: "assistant", local: true, at: Date.now(), sources: [...new Set(hits.map((h) => h.section.title))], content: `Here's the closest part of the User Manual (**${hits[0].section.title}**):\n\n${hits[0].part.length > 1100 ? `${hits[0].part.slice(0, 1100).trimEnd()}…` : hits[0].part}` };
  };
  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: q, at: Date.now() }];
    store(next);
    setDraft("");
    setError(null);
    if (ai === false) { store([...next, fromManual(q)]); return; }
    setBusy(true);
    try {
      // The last 20 messages are plenty for a help chat.
      const r = await api<{ answer: string; sources?: string[] }>("/help/ask", { body: { messages: next.slice(-20).map(({ role, content }) => ({ role, content: content.slice(0, 4000) })) } });
      store([...next, { role: "assistant", content: r.answer, sources: r.sources ?? [], at: Date.now() }]);
    } catch (e) {
      setError((e as Error).message);
      store(messages); // the question comes back to be asked again
      setDraft(q);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Head onBack={onBack} onClose={onClose} title={<span className="hp-agent"><Bot size={30} /><span><strong>Crewdesk Assistant</strong><span className="muted">{ai === false ? "Answers from the User Manual" : "AI · answers from the User Manual"}</span></span></span>}>
        {messages.length > 0 && <button type="button" className="hp-icon" aria-label="Delete this conversation" title="Delete this conversation" onClick={() => { if (confirm("Delete this conversation?")) { saveChats(chats.filter((c) => c.id !== id)); onBack(); } }}><Icon name="trash" size={16} /></button>}
      </Head>
      <div className="hp-body hp-chat" aria-live="polite">
        <div className="hp-msg assistant"><p>Hi {firstName}! Ask me how to do anything in Crewdesk and I&apos;ll walk you through it.</p></div>
        {ai === false && (
          <div className="hp-note">
            The AI assistant isn&apos;t turned on yet, so for now I&apos;ll show you the closest part of the User Manual.
            {admin ? " To turn it on, add an Anthropic API key as ANTHROPIC_API_KEY in the server's environment variables." : " Your Crewdesk admin can turn it on."}
          </div>
        )}
        {messages.length === 0 && (
          <div className="hp-suggest">
            {SUGGESTIONS.map((s) => <button key={s} type="button" disabled={busy} onClick={() => ask(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`hp-msg ${m.role}`}>
            {m.role === "user" ? <p>{m.content}</p> : <MarkdownLite text={m.content} className="help-answer" />}
            {m.role === "assistant" && !!m.sources?.length && (
              <div className="hp-sources">
                <span>From the User Manual</span>
                {m.sources.map((t) => <button key={t} type="button" onClick={() => onSource(t)}><Icon name="book" size={13} /> {t}</button>)}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="hp-msg assistant hp-typing" aria-label="The assistant is writing"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
      {error && <div className="hp-error" role="alert">{error}</div>}
      <form className="hp-compose" onSubmit={(e) => { e.preventDefault(); void ask(draft); }}>
        <textarea ref={box} value={draft} rows={Math.min(5, Math.max(1, draft.split("\n").length))} maxLength={4000} placeholder="Ask a question…" aria-label="Ask a question"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(draft); } }} />
        <button type="submit" className="hp-send" disabled={busy || !draft.trim()} aria-label="Send"><Icon name="send" size={16} /></button>
      </form>
      <div className="hp-fine">The assistant explains how Crewdesk works. It can&apos;t see or change your records, and it can be wrong.</div>
    </>
  );
}

/* ───────────── User Manual ───────────── */

function Manual({ sections, error, q, setQ, onArticle }: { sections: Section[] | null; error: string | null; q: string; setQ: (q: string) => void; onArticle: (title: string, part?: string) => void }) {
  const hits = useMemo(() => (sections && q.trim() ? searchManual(sections, q, 14) : []), [sections, q]);
  return (
    <div className="hp-body hp-manual">
      <label className="hp-search">
        <Icon name="search" size={16} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the User Manual" aria-label="Search the User Manual" autoFocus />
      </label>
      {error && <div className="hp-error" role="alert">{error}</div>}
      {!sections && !error && <span className="muted hp-pad">Loading the manual…</span>}
      {sections && q.trim() ? (
        <>
          <div className="hp-count muted">{hits.length ? `${hits.length} ${hits.length === 1 ? "match" : "matches"}` : "Nothing matches. Try other words, or ask the assistant under Help."}</div>
          {hits.map((h, i) => (
            <button key={i} type="button" className="hp-topic tall" onClick={() => onArticle(h.section.title, h.part)}>
              <span><strong>{h.section.title}</strong><span className="muted">{h.snippet}</span></span><Icon name="chevronRight" size={16} />
            </button>
          ))}
        </>
      ) : sections && (
        <>
          <div className="hp-count muted">{sections.length} sections</div>
          {sections.map((s) => (
            <button key={s.title} type="button" className="hp-topic tall" onClick={() => onArticle(s.title)}>
              <span><strong>{s.title}</strong>{s.lead && <span className="muted">{s.lead}</span>}</span><Icon name="chevronRight" size={16} />
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function Article({ section, loading, part }: { section: Section | null; loading: boolean; part?: string }) {
  if (!section) return <div className="hp-body hp-article"><span className="muted">{loading ? "Loading the manual…" : "That part of the manual has moved or been renamed. Go back and search for it."}</span></div>;
  return (
    <div className="hp-body hp-article">
      <h2>{section.title}</h2>
      {part && (
        <div className="hp-match">
          <span>The part that matches</span>
          <MarkdownLite text={part} className="help-answer" />
        </div>
      )}
      <MarkdownLite text={section.body} className="help-answer" />
      <Link className="hp-full" href={`/help?tab=manual#${slug(section.title)}`}>Open the full User Manual page</Link>
    </div>
  );
}
