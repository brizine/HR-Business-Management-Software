"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { entryHours } from "@crewdesk/shared";
import { API_URL, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { NAV, NEW_MENU, SIDES, pathMatches, type NavGroup, type NavItem, type Side } from "@/lib/nav";
import { Icon } from "@/components/icons";
import { useClockPunch } from "@/components/clock-card";
import { TestBadge, backToRealCompany } from "@/components/test-company";

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

export function TopBar(props: {
  side: Side; onSwitch: (s: Side) => void; unread: number; onMenu: () => void; visibleItems: (s: Side) => NavItem[];
}) {
  const { me } = useAuth();
  const [searching, setSearching] = useState(false);
  // Ctrl+K (or ⌘K) opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearching(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!me) return null;
  return (
    <header className={`topbar${me.company.isTest ? " is-test" : ""}`}>
      <button type="button" className="topbar-icon topbar-menu" aria-label="Open the menu" onClick={props.onMenu}><Icon name="menu" /></button>
      <Link href="/" className="topbar-brand" aria-label={`${me.company.name} home`}>
        {me.company.hasLogo
          ? <img src={`${API_URL}/company/logo${me.company.logoUpdatedAt ? `?v=${encodeURIComponent(me.company.logoUpdatedAt)}` : ""}`} alt={`${me.company.name} logo`} />
          : <span>{me.company.name}</span>}
      </Link>
      <TestBadge />
      <div className="side-switch" role="tablist" aria-label="Menu">
        {SIDES.map((o) => (
          <button key={o.key} type="button" role="tab" aria-selected={props.side === o.key} onClick={() => props.onSwitch(o.key)}>{o.label}</button>
        ))}
      </div>
      <button type="button" className="topbar-search" onClick={() => setSearching(true)} aria-label="Search (Ctrl+K)">
        <Icon name="search" size={16} /><span className="topbar-search-text">Search customers, properties, people…</span><kbd>Ctrl K</kbd>
      </button>
      <div className="topbar-spacer" />
      <ClockButton />
      <NewMenu />
      <Link href="/notifications" className="topbar-icon" aria-label={`Notifications${props.unread ? `, ${props.unread} unread` : ""}`} title="Notifications">
        <Icon name="bell" />{props.unread > 0 && <span className="topbar-count">{props.unread > 99 ? "99+" : props.unread}</span>}
      </Link>
      <Link href="/help" className="topbar-help" title="Help"><Icon name="help" size={18} /><span>Help</span></Link>
      <ProfileMenu />
      {searching && <SearchPalette onClose={() => setSearching(false)} visibleItems={props.visibleItems} />}
    </header>
  );
}

/** Clock in or out from any page; shows how long you've been on the clock. */
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
      <button type="button" className={`topbar-clock ${open ? "on" : ""}`} disabled={busy} aria-label={open ? `On the clock ${elapsed}. Clock out` : "Clock in"} title={open ? "On the clock: click to clock out" : "Clock in"}
        onClick={async () => {
          if (open && !confirm("Clock out now?")) return;
          setNote(true);
          await punch(open ? "clock-out" : "clock-in");
        }}>
        <Icon name="clock" size={16} /><span className="topbar-clock-label">{open ? "On the clock" : "Clock in"}</span>{open && <span className="topbar-clock-time">{elapsed}</span>}
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

/** "+ New": a grouped list of things to add, each opening the right page with its form. */
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
        <Icon name="plus" size={16} /><span>New</span>
      </button>
      {open && (
        <div className="topbar-popover topbar-menu-list" role="menu">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="menu-heading">{g.group}</div>
              {g.items.map((i) => (
                <button key={i.href} type="button" role="menuitem" onClick={() => {
                  setOpen(false);
                  router.push(i.href);
                  // Already on that page: tell it to open the form.
                  setTimeout(() => window.dispatchEvent(new Event("crewdesk:new")), 60);
                }}>{i.label}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Your name with My Info, Security, Settings and Sign out. */
function ProfileMenu() {
  const { me, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  if (!me) return null;
  const initials = `${me.user.firstName[0] ?? ""}${me.user.lastName[0] ?? ""}`.toUpperCase();
  return (
    <div className="topbar-pop" ref={ref}>
      <button type="button" className="topbar-avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`${me.user.firstName} ${me.user.lastName}: account menu`} onClick={() => setOpen(!open)}>{initials}</button>
      {open && (
        <div className="topbar-popover topbar-menu-list align-right" role="menu">
          <div className="menu-who"><strong>{me.user.firstName} {me.user.lastName}</strong><span className="muted">{me.user.role} · {me.company.name}</span></div>
          <Link role="menuitem" href="/settings/profile" onClick={close}>My Info</Link>
          <Link role="menuitem" href="/settings/security" onClick={close}>Security</Link>
          <Link role="menuitem" href="/settings/notifications" onClick={close}>Notification settings</Link>
          <Link role="menuitem" href="/settings/security" onClick={close}>All settings</Link>
          {me.company.isTest && <button type="button" role="menuitem" onClick={() => { setOpen(false); backToRealCompany(); }}>Back to the real company</button>}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); signOut().then(() => router.replace("/login")); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

type Hit = { kind: string; id: string; title: string; sub: string | null; href: string };
const KIND_LABELS: Record<string, string> = { page: "Pages", customer: "Customers", property: "Properties", employee: "People", asset: "Fleet" };

/** Ctrl+K search: pages you can open, plus customers, properties, people and fleet. */
function SearchPalette({ onClose, visibleItems }: { onClose: () => void; visibleItems: (s: Side) => NavItem[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const pages = useMemo(() => {
    const all = [...visibleItems("operations"), ...visibleItems("team"),
      { href: "/notifications", label: "Notifications" }, { href: "/wiki", label: "Company Wiki" }, { href: "/help", label: "Help" }, { href: "/settings/security", label: "Settings" }];
    const term = q.trim().toLowerCase();
    if (!term) return [];
    // Pages match from the start of a word ("pay" finds Payroll, "pra" doesn't find Spray Mix).
    const starts = (label: string) => label.toLowerCase().split(/[\s&/-]+/).some((w) => w.startsWith(term)) || label.toLowerCase().startsWith(term);
    const seen = new Set<string>();
    return all.filter((p) => starts(p.label) && !seen.has(p.href) && seen.add(p.href)).slice(0, 5).map((p) => ({ kind: "page", id: p.href, title: p.label, sub: null, href: p.href }));
  }, [q, visibleItems]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    const t = setTimeout(() => api<{ results: Hit[] }>(`/search?q=${encodeURIComponent(term)}`).then((r) => setHits(r.results), () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  // Records first (that's usually what you're looking for), then pages.
  const list = [...hits, ...pages];
  useEffect(() => { setActive(0); }, [q]);
  const go = (h: Hit) => { onClose(); router.push(h.href); };
  let lastKind = "";
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} placeholder="Search customers, properties, people, assets or pages" aria-label="Search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter" && list[active]) go(list[active]);
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" role="listbox">
          {q.trim().length < 2 && <p className="muted palette-hint">Type a name, address, phone, customer number, asset or page.</p>}
          {q.trim().length >= 2 && !list.length && <p className="muted palette-hint">No matches.</p>}
          {list.map((h, i) => {
            const heading = h.kind !== lastKind ? <div className="menu-heading" key={`h-${h.kind}`}>{KIND_LABELS[h.kind] ?? h.kind}</div> : null;
            lastKind = h.kind;
            return (
              <div key={`${h.kind}-${h.id}`}>
                {heading}
                <button type="button" role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(h)}>
                  <strong>{h.title}</strong>{h.sub && <span className="muted"> · {h.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Left menu ───────────────────────── */

/**
 * The left menu: one icon per group for the side you're on. Narrow, a group pops out its pages
 * (hover or click); expanded, every page is listed under its group. Wiki and Settings sit at the
 * bottom. On phones it opens as a drawer from the top bar's menu button.
 */
export function Rail(props: {
  side: Side; groups: NavGroup[]; expanded: boolean; onToggle: () => void; drawer: boolean; onCloseDrawer: () => void; onSwitch: (s: Side) => void;
  renderItem: (i: NavItem, onPick: () => void) => ReactNode;
}) {
  const path = usePathname();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpenGroup(null), []);
  useDismiss(!!openGroup, close, railRef);
  useEffect(() => { setOpenGroup(null); }, [path]);
  const wide = props.expanded || props.drawer;
  const groupActive = (g: NavGroup) => g.items.some((i) => pathMatches(path, i.href)) || (g.key === "pay" && (path.startsWith("/pay-periods") || path.startsWith("/tax-forms")));
  const pick = () => { setOpenGroup(null); props.onCloseDrawer(); };

  return (
    <>
      {props.drawer && <div className="rail-backdrop" onClick={props.onCloseDrawer} />}
      <nav ref={railRef} className={`rail ${wide ? "wide" : ""} ${props.drawer ? "drawer" : ""}`} aria-label="Main menu">
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
            return (
              <div key={g.key} className={`rail-group ${groupActive(g) ? "active" : ""}`}>
                {single ? (
                  <Link href={g.items[0].href} className={`rail-link ${groupActive(g) ? "active" : ""}`} onClick={pick}><Icon name={g.icon} size={18} /><span>{g.label}</span></Link>
                ) : (
                  <>
                    <div className="rail-heading"><Icon name={g.icon} size={18} /><span>{g.label}</span></div>
                    <div className="rail-items">{g.items.map((i) => <div key={i.href}>{props.renderItem(i, pick)}</div>)}</div>
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
          </>
        ) : (
          <>
            <Link href="/wiki" className={`rail-btn ${path.startsWith("/wiki") ? "active" : ""}`} title="Company Wiki"><Icon name="book" /><span>Wiki</span></Link>
            <Link href="/settings/security" className={`rail-btn ${path.startsWith("/settings") ? "active" : ""}`} title="Settings"><Icon name="settings" /><span>Settings</span></Link>
          </>
        )}
        {!props.drawer && (
          <button type="button" className="rail-toggle" onClick={props.onToggle} aria-label={props.expanded ? "Narrow the menu" : "Expand the menu"} title={props.expanded ? "Narrow the menu" : "Expand the menu"}>
            <Icon name={props.expanded ? "collapse" : "expand"} size={18} />
          </button>
        )}
      </nav>
    </>
  );
}
