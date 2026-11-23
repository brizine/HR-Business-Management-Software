"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { entryHours, formatTodoTime } from "@crewdesk/shared";
import { API_URL, api, fmtDateTime } from "@/lib/api";
import { hrefFor } from "@/lib/links";
import { useAuth } from "@/lib/auth";
import { NAV, NEW_MENU, SIDES, pathMatches, type NavGroup, type NavItem, type Side } from "@/lib/nav";
import { Icon } from "@/components/icons";
import { useClockPunch } from "@/components/clock-card";
import { TestBadge, backToRealCompany, openTestCompany } from "@/components/test-company";
import { THEME_CHOICES, setTheme, useTheme } from "@/lib/theme";
import { DoneBox, dayLabel, type Todo } from "@/components/todos";

/** Closes a pop-up when you click outside it or press Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close, ref]);
}

/* ───────────────────────── Top bar ───────────────────────── */

/** Phones and narrow windows: the menu opens as a drawer and search opens full screen. */
const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches;

/**
 * The top bar, laid out like Homeworks: menu toggle and company name on the left, search in the
 * middle, then the time clock, notifications, + New and your account menu on the right.
 */
export function TopBar(props: {
  side: Side; onSwitch: (s: Side) => void; unread: number; onMenu: () => void; onToggleRail: () => void; railExpanded: boolean;
  visibleItems: (s: Side) => NavItem[];
}) {
  const { me } = useAuth();
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  // Ctrl+K (or ⌘K) jumps to search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) return;
      e.preventDefault();
      if (isNarrow() || !searchInput.current) setSearching(true);
      else searchInput.current.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!me) return null;
  return (
    <header className={`topbar${me.company.isTest ? " is-test" : ""}`}>
      <button type="button" className="topbar-icon topbar-toggle" aria-label={props.railExpanded ? "Narrow the menu" : "Expand the menu"} title="Show or hide the menu"
        onClick={() => (isNarrow() ? props.onMenu() : props.onToggleRail())}><Icon name="sidebar" /></button>
      <Link href="/" className="topbar-brand" title={`${me.company.name}: home`}><span>{me.company.name}</span></Link>
      <TestBadge />
      <div className="side-switch" role="tablist" aria-label="Menu">
        {SIDES.map((o) => (
          <button key={o.key} type="button" role="tab" aria-selected={props.side === o.key} onClick={() => props.onSwitch(o.key)}>{o.label}</button>
        ))}
      </div>
      <div className="topbar-spacer" />
      <InlineSearch inputRef={searchInput} visibleItems={props.visibleItems} />
      <button type="button" className="topbar-icon topbar-search-btn" aria-label="Search" onClick={() => setSearching(true)}><Icon name="search" /></button>
      <div className="topbar-spacer" />
      <ClockButton />
      <TodosButton />
      <NotificationsBell unread={props.unread} />
      <NewMenu />
      <ProfileMenu />
      {searching && <SearchPalette onClose={() => setSearching(false)} visibleItems={props.visibleItems} />}
    </header>
  );
}

/** Clocked out / Clocked in: clock in or out from any page, and see how long you've been on. */
function ClockButton() {
  const { status, open, busy, error, setError, result, setResult, punch } = useClockPunch();
  const [note, setNote] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setNote(false); setError(null); setResult(null); }, [setError, setResult]);
  useDismiss(note, close, ref);
  if (status.loading && !status.data) return null;
  if (status.error) return null;
  const hours = open ? entryHours(open) : 0;
  const elapsed = open ? `${Math.floor(hours)}h ${String(Math.round((hours % 1) * 60)).padStart(2, "0")}m` : "";
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className={`topbar-clock ${open ? "on" : ""}`} disabled={busy}
        aria-label={open ? `Clocked in ${elapsed}. Clock out` : "Clocked out. Clock in"} title={open ? "Clocked in: click to clock out" : "Clocked out: click to clock in"}
        onClick={async () => {
          if (!confirm(open ? "Clock out now?" : "Clock in now?")) return;
          setNote(true);
          await punch(open ? "clock-out" : "clock-in");
        }}>
        <Icon name={open ? "clock" : "clockOff"} size={16} /><span className="topbar-clock-label">{open ? "Clocked in" : "Clocked out"}</span>{open && <span className="topbar-clock-time">{elapsed}</span>}
      </button>
      {note && (error || result) && (
        <div className="topbar-popover" role="status">
          {error ? <span className="error">{error}</span> : result}
          <div><Link href="/time" onClick={close}>Open the Time Clock</Link></div>
        </div>
      )}
    </div>
  );
}

/** The to-do icon: how many of yours are due today or overdue; click for the list, to tick them off or add one. */
function TodosButton() {
  const router = useRouter();
  const path = usePathname();
  const [due, setDue] = useState(0);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ today: string; items: Todo[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  useEffect(() => { setOpen(false); }, [path]);
  const load = useCallback(() => {
    api<{ due: number }>("/todos/count").then((r) => setDue(r.due), () => {});
  }, []);
  const loadList = useCallback(() => {
    api<{ today: string; items: Todo[] }>("/todos?mine=true&to=today&limit=20").then(setList, () => setList({ today: "", items: [] }));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    const changed = () => { load(); if (open) loadList(); };
    window.addEventListener("crewdesk:todos", changed);
    window.addEventListener("focus", load);
    return () => { clearInterval(timer); window.removeEventListener("crewdesk:todos", changed); window.removeEventListener("focus", load); };
  }, [load, loadList, open]);
  useEffect(() => { if (open) loadList(); }, [open, loadList]);
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="topbar-icon" aria-haspopup="dialog" aria-expanded={open} title="To-dos"
        aria-label={`To-dos${due ? `, ${due} due` : ""}`} onClick={() => setOpen(!open)}>
        <Icon name="todo" />{due > 0 && <span className="topbar-count">{due > 99 ? "99+" : due}</span>}
      </button>
      {open && (
        <div className="topbar-popover align-right bell-pop" role="dialog" aria-label="Your to-dos">
          <div className="bell-head"><strong>Your to-dos for today</strong>
            <button type="button" className="linkbtn" onClick={() => { setOpen(false); router.push("/todos?new=1"); setTimeout(() => window.dispatchEvent(new Event("crewdesk:new")), 60); }}>+ New to-do</button>
          </div>
          {list === null ? <p className="muted bell-empty">Loading…</p>
            : !list.items.length ? <p className="muted bell-empty">Nothing due today</p>
            : (
              <ul className="bell-list todo-pop-list">
                {list.items.map((t) => (
                  <li key={t.id} style={{ borderLeftColor: t.color }}>
                    <DoneBox t={t} onChange={(u) => setList((l) => (l ? { ...l, items: l.items.map((x) => (x.id === u.id ? u : x)) } : l))} />
                    <button type="button" onClick={() => { setOpen(false); router.push(`/todos/${t.id}`); }}>
                      <strong className={t.doneAt ? "todo-struck" : undefined}>{t.title}</strong>
                      <span className="muted">{[(t.endDate ?? t.date) < list.today ? `Overdue · ${dayLabel(t.date)}` : formatTodoTime(t.startTime, t.endTime), t.property?.address ?? t.location].filter(Boolean).join(" · ") || "Today"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <Link href="/todos" className="btn bell-all" onClick={close}>View all</Link>
        </div>
      )}
    </div>
  );
}

type Note = { id: string; title: string; body: string | null; link: any; readAt: string | null; createdAt: string };

/** The bell: your new notifications in a pop-up, with View all and Mark all as read. */
function NotificationsBell({ unread }: { unread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Note[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  const load = useCallback(() => api<{ items: Note[] }>("/notifications").then((r) => setItems(r.items.filter((n) => !n.readAt).slice(0, 8)), () => setItems([])), []);
  useEffect(() => { if (open) load(); }, [open, load]);
  const changed = () => window.dispatchEvent(new Event("crewdesk:notifications"));
  const pick = async (n: Note) => {
    setOpen(false);
    await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => {});
    changed();
    router.push(hrefFor(n.link) ?? "/notifications");
  };
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="topbar-icon" aria-haspopup="dialog" aria-expanded={open} title="Notifications"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} onClick={() => setOpen(!open)}>
        <Icon name="bell" />{unread > 0 && <span className="topbar-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="topbar-popover align-right bell-pop" role="dialog" aria-label="Notifications">
          <div className="bell-head"><strong>Notifications</strong>
            {!!items?.length && <button type="button" className="linkbtn" onClick={() => api("/notifications/read-all", { method: "POST" }).then(() => { changed(); setItems([]); }, () => {})}>Mark all as read</button>}
          </div>
          {items === null ? <p className="muted bell-empty">Loading…</p>
            : !items.length ? <p className="muted bell-empty">No new notifications</p>
            : (
              <ul className="bell-list">
                {items.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => pick(n)}>
                      <strong>{n.title}</strong>{n.body && <span className="muted">{n.body}</span>}
                      <span className="muted bell-when">{fmtDateTime(n.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <Link href="/notifications" className="btn bell-all" onClick={close}>View all</Link>
        </div>
      )}
    </div>
  );
}

/** "+ New": everything you can add, in columns; each opens the right page with its form showing. */
function NewMenu() {
  const { can } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  const groups = NEW_MENU.map((g) => ({ ...g, items: g.items.filter((i) => !i.min || can(i.min, i.area)) })).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="btn primary topbar-new" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={16} /><span>New</span><Icon name="chevron" size={14} className="topbar-new-caret" />
      </button>
      {open && (
        <div className="topbar-popover align-right new-mega" role="menu" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(140px, auto))` }}>
          {groups.map((g) => (
            <div key={g.group} className="new-col" role="group" aria-label={g.group}>
              <div className="menu-heading">{g.group}</div>
              {g.items.map((i) => (
                <button key={i.href} type="button" role="menuitem" onClick={() => {
                  setOpen(false);
                  router.push(i.href);
                  // Already on that page: tell it to open the form.
                  setTimeout(() => window.dispatchEvent(new Event("crewdesk:new")), 60);
                }}>{i.icon && <Icon name={i.icon} size={16} />}<span>{i.label}</span></button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Your initials: My profile, the Wiki, settings and Sign out. */
function ProfileMenu() {
  const { me, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  // The test company (looked up when the menu opens): open it, or set one up (owners).
  const [testCo, setTestCo] = useState<{ isTest: boolean; exists?: boolean; name?: string | null; canOpen?: boolean; canCreate?: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!open || testCo || me?.company.isTest) return;
    api<NonNullable<typeof testCo>>("/auth/test-company").then(setTestCo, () => setTestCo({ isTest: false }));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me) return null;
  const initials = `${me.user.firstName[0] ?? ""}${me.user.lastName[0] ?? ""}`.toUpperCase();
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="topbar-avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`${me.user.firstName} ${me.user.lastName}: account menu`} onClick={() => setOpen(!open)}>{initials}</button>
      {open && (
        <div className="topbar-popover topbar-menu-list align-right" role="menu">
          <div className="menu-who"><strong>{me.user.firstName} {me.user.lastName}</strong><span className="muted">{me.user.role} · {me.company.name}</span></div>
          <Link role="menuitem" href="/settings/profile" onClick={close}>My profile</Link>
          <Link role="menuitem" href="/wiki" onClick={close}>Company Wiki</Link>
          <Link role="menuitem" href="/settings/notifications" onClick={close}>Notification settings</Link>
          <Link role="menuitem" href="/settings/security" onClick={close}>Security</Link>
          <Link role="menuitem" href="/settings/security" onClick={close}>All settings</Link>
          <Link role="menuitem" href="/help" onClick={close}>Help</Link>
          {me.company.isTest && <button type="button" role="menuitem" onClick={() => { setOpen(false); backToRealCompany(); }}>Back to the real company</button>}
          {!me.company.isTest && testCo?.exists && testCo.canOpen && (
            <button type="button" role="menuitem" disabled={switching} onClick={() => { setSwitching(true); openTestCompany().catch((e) => { setSwitching(false); alert((e as Error).message); }); }}>
              {switching ? "Opening…" : `Open ${testCo.name ?? "test company"}`}
            </button>
          )}
          {!me.company.isTest && testCo && !testCo.exists && testCo.canCreate && <Link role="menuitem" href="/settings/company-info" onClick={close}>Set up a test company</Link>}
          <button type="button" role="menuitem" className="menu-danger" onClick={() => { setOpen(false); signOut().then(() => router.replace("/login")); }}>
            <Icon name="logout" size={16} />Sign out
          </button>
        </div>
      )}
    </div>
  );
}

type Hit = { kind: string; id: string; title: string; sub: string | null; href: string };
const KIND_LABELS: Record<string, string> = {
  page: "Pages", customer: "Customers", property: "Properties", visit: "Work orders", invoice: "Invoices", payment: "Payments", service: "Price list",
  employee: "People", asset: "Fleet", workOrder: "Repair orders", todo: "To-dos", quick: "Quick links", account: "Account",
};

/**
 * What search finds for what you've typed: customers, properties, people and fleet (from the server),
 * then pages you can open. Empty, it offers quick links. Grouped by kind, in the order shown.
 */
function useSearchResults(q: string, visibleItems: (s: Side) => NavItem[]) {
  const [hits, setHits] = useState<Hit[]>([]);
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) { setHits([]); return; }
    const t = setTimeout(() => api<{ results: Hit[] }>(`/search?q=${encodeURIComponent(term)}`).then((r) => setHits(r.results), () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [term]);
  return useMemo(() => {
    const visible = [...visibleItems("operations"), ...visibleItems("team")];
    if (!term) {
      // Like Homeworks: Customers, the team and the schedule, then your account.
      const quick = ["/customers", "/people", "/schedule"].flatMap((href) => {
        const item = visible.find((i) => i.href === href);
        return item ? [{ kind: "quick", id: href, title: item.label, sub: null, href }] : [];
      });
      return [...quick, { kind: "account", id: "settings", title: "Account settings", sub: null, href: "/settings/security" }];
    }
    const all = [...visible, { href: "/notifications", label: "Notifications" }, { href: "/wiki", label: "Company Wiki" }, { href: "/help", label: "Help" }, { href: "/settings/security", label: "Settings" }];
    const lower = term.toLowerCase();
    // Pages match from the start of a word ("pay" finds Payroll, "pra" doesn't find Spray Mix).
    const starts = (label: string) => label.toLowerCase().split(/[\s&/-]+/).some((w) => w.startsWith(lower)) || label.toLowerCase().startsWith(lower);
    const seen = new Set<string>();
    const pages = all.filter((p) => starts(p.label) && !seen.has(p.href) && seen.add(p.href)).slice(0, 5)
      .map((p) => ({ kind: "page", id: p.href, title: p.label, sub: null, href: p.href }));
    // Records first (that's usually what you're looking for), then pages. Customers end with "See all".
    const list: Hit[] = [];
    hits.forEach((h, i) => {
      list.push(h);
      if (h.kind === "customer" && hits[i + 1]?.kind !== "customer") {
        list.push({ kind: "customer", id: "see-all", title: "See all customers…", sub: null, href: `/customers?q=${encodeURIComponent(term)}` });
      }
    });
    return [...list, ...pages];
  }, [term, hits, visibleItems]);
}

/** One result row (shared by the top bar's search and the full-screen search on phones). */
function ResultList({ list, active, setActive, go, empty }: { list: Hit[]; active: number; setActive: (i: number) => void; go: (h: Hit) => void; empty: ReactNode }) {
  let lastKind = "";
  if (!list.length) return <>{empty}</>;
  return (
    <>
      {list.map((h, i) => {
        const heading = h.kind !== lastKind ? <div className="menu-heading" key={`h-${h.kind}`}>{KIND_LABELS[h.kind] ?? h.kind}</div> : null;
        lastKind = h.kind;
        return (
          <div key={`${h.kind}-${h.id}`}>
            {heading}
            <button type="button" role="option" aria-selected={i === active} className={`${i === active ? "active" : ""}${h.id === "see-all" ? " see-all" : ""}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
              {h.id === "see-all" ? <span>» {h.title}</span> : <><strong>{h.title}</strong>{h.sub && <span className="muted"> · {h.sub}</span>}</>}
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Arrow keys, Enter and Escape for a result list. */
function useResultKeys(list: Hit[], go: (h: Hit) => void, onEscape: () => void) {
  const [active, setActive] = useState(0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onEscape();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && list[active]) { e.preventDefault(); go(list[active]); }
  };
  return { active, setActive, onKeyDown };
}

/** The search box in the middle of the top bar, with its results dropping down under it. */
function InlineSearch({ inputRef, visibleItems }: { inputRef: React.RefObject<HTMLInputElement | null>; visibleItems: (s: Side) => NavItem[] }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  useEffect(() => { setOpen(false); }, [path]);
  const list = useSearchResults(q, visibleItems);
  const go = (h: Hit) => { setOpen(false); setQ(""); inputRef.current?.blur(); router.push(h.href); };
  const { active, setActive, onKeyDown } = useResultKeys(list, go, () => { setOpen(false); inputRef.current?.blur(); });
  useEffect(() => { setActive(0); }, [q, setActive]);
  const term = q.trim();
  return (
    <div className="topbar-search" ref={ref}>
      <Icon name="search" size={16} />
      <input ref={inputRef} value={q} placeholder="Search" aria-label="Search customers, properties, invoices, people, fleet or pages (Ctrl+K)"
        role="combobox" aria-expanded={open} aria-controls="topbar-search-results" autoComplete="off"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKeyDown} />
      {!open && <kbd>Ctrl+K</kbd>}
      {open && (
        <div className="topbar-popover search-drop" id="topbar-search-results" role="listbox">
          <ResultList list={list} active={active} setActive={setActive} go={go}
            empty={<p className="muted palette-hint">{term.length < 2 ? "Type a name, address, phone, customer or invoice number, check number, asset, repair order or page." : "No matches."}</p>} />
        </div>
      )}
    </div>
  );
}

/** Full-screen search on phones (the top bar's search icon). */
function SearchPalette({ onClose, visibleItems }: { onClose: () => void; visibleItems: (s: Side) => NavItem[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const list = useSearchResults(q, visibleItems);
  const go = (h: Hit) => { onClose(); router.push(h.href); };
  const { active, setActive, onKeyDown } = useResultKeys(list, go, onClose);
  useEffect(() => { setActive(0); }, [q, setActive]);
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} placeholder="Search customers, invoices, people, fleet…" aria-label="Search"
            onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} />
          <button type="button" className="topbar-icon palette-close" aria-label="Close search" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <div className="palette-results" role="listbox">
          <ResultList list={list} active={active} setActive={setActive} go={go} empty={<p className="muted palette-hint">No matches.</p>} />
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Left menu ───────────────────────── */

const THEME_SLOT = "__theme";

/** Light, dark or auto (match the device), like Homeworks: three icons at the bottom of the open menu. */
function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Light or dark mode">
      {THEME_CHOICES.map((c) => (
        <button key={c.key} type="button" role="radio" aria-checked={theme === c.key} aria-label={c.hint} title={c.hint} onClick={() => setTheme(c.key)}>
          <Icon name={c.icon} size={16} />
        </button>
      ))}
    </div>
  );
}

const OPEN_KEY = "crewdesk.menu-open";

/**
 * The left menu: one icon per group for the side you're on. Narrow, a group pops out its pages
 * (hover or click); expanded, each heading opens and closes its pages, with the company logo on top.
 * Wiki, Settings and Help sit at the bottom. The top bar's menu button widens or narrows it; on
 * phones the same button opens it as a drawer.
 */
export function Rail(props: {
  side: Side; groups: NavGroup[]; expanded: boolean; drawer: boolean; onCloseDrawer: () => void; onSwitch: (s: Side) => void;
  renderItem: (i: NavItem, onPick: () => void) => ReactNode;
}) {
  const { me } = useAuth();
  const path = usePathname();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpenGroup(null), []);
  useDismiss(!!openGroup, close, railRef);
  useEffect(() => { setOpenGroup(null); }, [path]);
  const wide = props.expanded || props.drawer;
  const theme = useTheme();
  const themeNow = THEME_CHOICES.find((c) => c.key === theme) ?? THEME_CHOICES[2];
  const groupActive = (g: NavGroup) => g.items.some((i) => pathMatches(path, i.href)) || (g.key === "pay" && (path.startsWith("/pay-periods") || path.startsWith("/tax-forms")));
  const pick = () => { setOpenGroup(null); props.onCloseDrawer(); };
  // Which headings are open in the expanded menu: what each person opened or closed (kept in this
  // browser); otherwise just the section of the page you're on.
  const [shown, setShown] = useState<Record<string, boolean>>({});
  useEffect(() => { try { setShown(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}")); } catch { /* storage blocked */ } }, []);
  const isOpen = (g: NavGroup) => shown[`${props.side}:${g.key}`] ?? groupActive(g);
  const toggleGroup = (g: NavGroup) => setShown((s) => {
    const k = `${props.side}:${g.key}`;
    const next = { ...s, [k]: !(s[k] ?? groupActive(g)) };
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    return next;
  });

  return (
    <>
      {props.drawer && <div className="rail-backdrop" onClick={props.onCloseDrawer} />}
      <nav ref={railRef} className={`rail ${wide ? "wide" : ""} ${props.drawer ? "drawer" : ""}`} aria-label="Main menu">
        {wide && me?.company.hasLogo && (
          <Link href="/" className="rail-logo" onClick={pick} aria-label={`${me.company.name} home`}>
            <img src={`${API_URL}/company/logo${me.company.logoUpdatedAt ? `?v=${encodeURIComponent(me.company.logoUpdatedAt)}` : ""}`} alt={`${me.company.name} logo`} />
          </Link>
        )}
        {props.drawer && (
          <div className="side-switch rail-switch" role="tablist" aria-label="Menu">
            {SIDES.map((o) => (
              <button key={o.key} type="button" role="tab" aria-selected={props.side === o.key} onClick={() => props.onSwitch(o.key)}>{o.label}</button>
            ))}
          </div>
        )}
        {props.groups.map((g) => {
          const single = g.items.length === 1;
          if (wide) {
            // Like Homeworks: each heading opens and closes its pages. The section you're in starts open.
            const open = isOpen(g);
            return (
              <div key={g.key} className={`rail-group ${groupActive(g) ? "active" : ""}`}>
                {single ? (
                  <Link href={g.items[0].href} className={`rail-link ${groupActive(g) ? "active" : ""}`} onClick={pick}><Icon name={g.icon} size={18} /><span>{g.label}</span></Link>
                ) : (
                  <>
                    <button type="button" className={`rail-link rail-heading-btn ${groupActive(g) && !open ? "active" : ""}`} aria-expanded={open} aria-controls={`rail-${props.side}-${g.key}`}
                      onClick={() => toggleGroup(g)}>
                      <Icon name={g.icon} size={18} /><span>{g.label}</span><Icon name={open ? "chevron" : "right"} size={16} className="rail-caret" />
                    </button>
                    {open && <div id={`rail-${props.side}-${g.key}`} className="rail-items">{g.items.map((i) => <div key={i.href}>{props.renderItem(i, pick)}</div>)}</div>}
                  </>
                )}
              </div>
            );
          }
          return (
            <div key={g.key} className="rail-slot"
              onMouseEnter={() => !single && setOpenGroup(g.key)} onMouseLeave={() => setOpenGroup((o) => (o === g.key ? null : o))}>
              {single ? (
                <Link href={g.items[0].href} className={`rail-btn ${groupActive(g) ? "active" : ""}`} title={g.label}>
                  <Icon name={g.icon} /><span>{g.label}</span>
                </Link>
              ) : (
                <button type="button" className={`rail-btn ${groupActive(g) ? "active" : ""}`} aria-haspopup="menu" aria-expanded={openGroup === g.key}
                  onClick={() => setOpenGroup(openGroup === g.key ? null : g.key)}>
                  <Icon name={g.icon} /><span>{g.label}</span>
                </button>
              )}
              {openGroup === g.key && (
                <div className="rail-flyout" role="menu" aria-label={g.label}>
                  <div className="menu-heading">{g.label}</div>
                  {g.items.map((i) => <div key={i.href}>{props.renderItem(i, pick)}</div>)}
                </div>
              )}
            </div>
          );
        })}
        <div className="rail-spacer" />
        {wide ? (
          <>
            <Link href="/wiki" className={`rail-link ${path.startsWith("/wiki") ? "active" : ""}`} onClick={pick}><Icon name="book" size={18} /><span>Company Wiki</span></Link>
            <Link href="/settings/security" className={`rail-link ${path.startsWith("/settings") ? "active" : ""}`} onClick={pick}><Icon name="settings" size={18} /><span>Settings</span></Link>
            <Link href="/help" className={`rail-link ${path.startsWith("/help") ? "active" : ""}`} onClick={pick}><Icon name="help" size={18} /><span>Help</span></Link>
            <ThemeSwitch />
          </>
        ) : (
          <>
            <Link href="/wiki" className={`rail-btn ${path.startsWith("/wiki") ? "active" : ""}`} title="Company Wiki"><Icon name="book" /><span>Wiki</span></Link>
            <Link href="/settings/security" className={`rail-btn ${path.startsWith("/settings") ? "active" : ""}`} title="Settings"><Icon name="settings" /><span>Settings</span></Link>
            <Link href="/help" className={`rail-btn ${path.startsWith("/help") ? "active" : ""}`} title="Help"><Icon name="help" /><span>Help</span></Link>
            <div className="rail-slot">
              <button type="button" className="rail-btn" aria-haspopup="menu" aria-expanded={openGroup === THEME_SLOT} title="Light or dark mode"
                onClick={() => setOpenGroup(openGroup === THEME_SLOT ? null : THEME_SLOT)}>
                <Icon name={themeNow.icon} /><span>{themeNow.label}</span>
              </button>
              {openGroup === THEME_SLOT && (
                <div className="rail-flyout up" role="menu" aria-label="Light or dark mode">
                  <div className="menu-heading">Light or dark mode</div>
                  {THEME_CHOICES.map((c) => (
                    <button key={c.key} type="button" role="menuitemradio" aria-checked={theme === c.key} className="theme-option"
                      onClick={() => { setTheme(c.key); setOpenGroup(null); }}>
                      <Icon name={c.icon} size={16} /><span>{c.label}</span>{c.key === "auto" && <span className="muted">(this device)</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </nav>
    </>
  );
}
