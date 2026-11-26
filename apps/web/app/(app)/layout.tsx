"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Trail } from "@/components/trail";
import { NAV, pathMatches, sideOf, type NavGroup, type NavItem, type Side } from "@/lib/nav";
import { PageLayoutRoot } from "@/components/page-layout";
import { Rail, TopBar } from "@/components/app-shell";

const SIDE_KEY = "crewdesk.side";
const RAIL_KEY = "crewdesk.menu-expanded";

/** Unread count for the top bar; polls every minute and refreshes when the inbox changes. */
function useUnreadCount(enabled: boolean) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const load = () => api<{ unread: number }>("/notifications/unread-count").then((r) => setUnread(r.unread), () => {});
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener("crewdesk:notifications", load);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("crewdesk:notifications", load);
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return unread;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, ready, can } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const unread = useUnreadCount(!!me);
  // Pay period approvers who aren't payroll admins get a Payroll link that opens Payroll Approval.
  const [payApprovals, setPayApprovals] = useState<{ isApprover: boolean; pending: number } | null>(null);
  useEffect(() => {
    if (me) api<{ isApprover: boolean; pending: number }>("/pay-periods/me").then(setPayApprovals, () => {});
  }, [me?.user.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bigcapital's address, for the Accounting link (payroll admins only; empty until connected).
  const canAccounting = !!me && can("admin", "payroll");
  const [booksUrl, setBooksUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!canAccounting) return setBooksUrl(null);
    api<{ enabled: boolean; hasKey: boolean; baseUrl: string }>("/accounting/settings")
      .then((r) => setBooksUrl(r.enabled && r.hasKey && r.baseUrl ? r.baseUrl : null), () => setBooksUrl(null));
  }, [canAccounting, me?.company.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // The browser tab shows the company's name (re-applied on navigation in case Next resets it).
  const companyName = me?.company.name;
  useEffect(() => {
    if (companyName) document.title = companyName;
  }, [companyName, path]);

  useEffect(() => {
    if (ready && !me) router.replace("/login");
  }, [ready, me, router]);

  // The side shown follows the page you're on; on shared pages it stays on the last one used.
  const [stored, setStored] = useState<Side>("operations");
  const [expanded, setExpanded] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDE_KEY); if (v === "operations" || v === "team") setStored(v);
      setExpanded(localStorage.getItem(RAIL_KEY) === "1");
    } catch { /* storage blocked */ }
  }, []);
  const pageSide = sideOf(path);
  useEffect(() => {
    if (!pageSide) return;
    setStored(pageSide);
    try { localStorage.setItem(SIDE_KEY, pageSide); } catch { /* storage blocked */ }
  }, [pageSide]);
  useEffect(() => { setDrawer(false); }, [path]);
  const side = pageSide ?? stored;
  if (!me) return null;

  /** The menu items this person can use (pay period approvers get Payroll Approval as their Payroll link). */
  const visibleItems = (items: NavItem[]) => items
    .map((i) => (i.href === "/payroll" && !can("admin", "payroll") && payApprovals?.isApprover ? { ...i, href: "/pay-periods", min: undefined } : i))
    .filter((i) => !i.min || can(i.min, i.area))
    .filter((i) => i.gate !== "chemical" || !!me?.access?.chemicalTracking)
    .filter((i) => i.gate !== "texting" || !!me?.access?.texting)
    // Payroll admins reach Pay & Tax Forms from a button on the Payroll page.
    .filter((i) => !(i.href === "/tax-forms" && can("admin", "payroll")));
  const groupsFor = (s: Side): NavGroup[] => NAV[s].map((g) => ({ ...g, items: visibleItems(g.items) })).filter((g) => g.items.length);
  const switchTo = (to: Side) => {
    if (to === side) return;
    setStored(to);
    try { localStorage.setItem(SIDE_KEY, to); } catch { /* storage blocked */ }
    // Open the side's first page, skipping Reports so you land somewhere you work.
    const items = groupsFor(to).flatMap((g) => g.items);
    const first = items.find((i) => !i.href.startsWith("/reports")) ?? items[0];
    if (first) router.push(first.href);
  };
  const toggleRail = () => {
    setExpanded((e) => {
      try { localStorage.setItem(RAIL_KEY, e ? "0" : "1"); } catch { /* storage blocked */ }
      return !e;
    });
  };
  const renderItem = (i: NavItem, onPick: () => void) => {
    const active = pathMatches(path, i.href) || (i.href === "/payroll" && (path.startsWith("/pay-periods") || path.startsWith("/tax-forms")));
    if (i.href === "/accounting" && booksUrl) {
      return <a href={booksUrl} target="_blank" rel="noopener noreferrer" title="Opens Bigcapital in a new tab" className="menu-link" onClick={onPick}>{i.label}</a>;
    }
    return (
      <Link href={i.href} className={`menu-link ${active ? "active" : ""}`} onClick={onPick}>
        {i.label}
        {i.href === "/payroll" && !!payApprovals?.pending && <span className="badge warn" style={{ marginLeft: 6 }} title="Pay periods waiting for your approval">{payApprovals.pending}</span>}
      </Link>
    );
  };

  return (
    <div className="app">
      <TopBar side={side} onSwitch={switchTo} unread={unread} onMenu={() => setDrawer(true)} onToggleRail={toggleRail} railExpanded={expanded} visibleItems={(s) => groupsFor(s).flatMap((g) => g.items)} />
      <div className="shell">
        <Rail side={side} groups={groupsFor(side)} expanded={expanded} drawer={drawer} onCloseDrawer={() => setDrawer(false)} onSwitch={switchTo} renderItem={renderItem} />
        <main className="main"><Trail /><PageLayoutRoot>{children}</PageLayoutRoot></main>
      </div>
    </div>
  );
}
