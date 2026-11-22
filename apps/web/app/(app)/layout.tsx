"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";
import type { PermissionArea, Role } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { PageLayoutRoot } from "@/components/page-layout";

type NavItem = { href: string; label: string; min?: Role; area?: PermissionArea };
type NavSection = { section: string; items: NavItem[] };
/** The sidebar has two sides: Operations (customers, field tools, fleet) and Team (people and pay). */
type Side = "operations" | "team";
const SIDES: { key: Side; label: string }[] = [{ key: "operations", label: "Operations" }, { key: "team", label: "Team" }];
const NAV: Record<Side, NavSection[]> = {
  operations: [
    { section: "", items: [{ href: "/reports/operations", label: "Reports", min: "manager", area: "fleet" }] },
    {
      section: "Customers",
      items: [
        { href: "/customers", label: "Customers", min: "manager", area: "customers" },
        { href: "/properties", label: "Properties", min: "manager", area: "customers" },
      ],
    },
    {
      section: "Tools",
      items: [
        { href: "/measure", label: "Property Measure" },
        { href: "/spray-mix", label: "Spray Mix Calculator" },
      ],
    },
    {
      section: "Fleet & Equipment",
      items: [
        { href: "/fleet", label: "Assets" },
        { href: "/work-orders", label: "Repair Orders" },
        { href: "/inspections", label: "Inspections" },
      ],
    },
  ],
  team: [
    { section: "", items: [{ href: "/dashboard", label: "Dashboard", min: "manager", area: "dashboard" }, { href: "/reports/team", label: "Reports", min: "manager" }] },
    {
      section: "People",
      items: [
        { href: "/people", label: "Team" },
        { href: "/schedule", label: "Shifts" },
        { href: "/time", label: "Time Clock" },
        { href: "/attendance", label: "Attendance" },
        { href: "/time-off", label: "Time Off" },
        { href: "/reviews", label: "Reviews & Discipline" },
        { href: "/training", label: "Training" },
        { href: "/documents", label: "Documents" },
        { href: "/onboarding", label: "Onboarding" },
        { href: "/hiring", label: "Hiring", min: "manager", area: "hiring" },
      ],
    },
    {
      section: "Pay",
      items: [
        { href: "/payroll", label: "Payroll", min: "admin", area: "payroll" },
        // Opens Bigcapital in a new tab once it's connected; until then, the Integrations settings.
        { href: "/accounting", label: "Accounting", min: "admin", area: "payroll" },
        { href: "/tax-forms", label: "Pay & Tax Forms" },
      ],
    },
  ],
};
/** Pages that belong to a side without a menu item of their own. */
const EXTRA: Record<Side, string[]> = { operations: [], team: ["/pay-periods"] };
const SIDE_KEY = "crewdesk.side";

/** Which side a page belongs to (null for shared pages such as Notifications, Wiki, Help and Settings). */
function sideOf(path: string): Side | null {
  const hit = (href: string) => path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`);
  for (const side of ["operations", "team"] as Side[]) {
    if (NAV[side].some((s) => s.items.some((i) => hit(i.href))) || EXTRA[side].some(hit)) return side;
  }
  return null;
}

/** Unread count for the sidebar; polls every minute and refreshes when the inbox changes. */
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
  const { me, ready, signOut, can } = useAuth();
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
  useEffect(() => {
    try { const v = localStorage.getItem(SIDE_KEY); if (v === "operations" || v === "team") setStored(v); } catch { /* storage blocked */ }
  }, []);
  const pageSide = sideOf(path);
  useEffect(() => {
    if (!pageSide) return;
    setStored(pageSide);
    try { localStorage.setItem(SIDE_KEY, pageSide); } catch { /* storage blocked */ }
  }, [pageSide]);
  const side = pageSide ?? stored;
  if (!me) return null;

  const visible = (sections: NavSection[]) => sections
    .map((s) => ({
      ...s,
      items: s.items
        .map((i) => (i.href === "/payroll" && !can("admin", "payroll") && payApprovals?.isApprover ? { ...i, href: "/pay-periods", min: undefined } : i))
        .filter((i) => !i.min || can(i.min, i.area))
        // Payroll admins reach Pay & Tax Forms from a button on the Payroll page.
        .filter((i) => !(i.href === "/tax-forms" && can("admin", "payroll"))),
    }))
    .filter((s) => s.items.length);
  const switchTo = (to: Side) => {
    if (to === side) return;
    setStored(to);
    try { localStorage.setItem(SIDE_KEY, to); } catch { /* storage blocked */ }
    // Open the side's first page, skipping Reports so you land somewhere you work.
    const items = visible(NAV[to]).flatMap((s) => s.items);
    const first = items.find((i) => !i.href.startsWith("/reports")) ?? items[0];
    if (first) router.push(first.href);
  };

  return (
    <div className="shell">
      <nav className="sidebar">
        {me.company.hasLogo && (
          <img className="sidebar-logo" src={`${API_URL}/company/logo${me.company.logoUpdatedAt ? `?v=${encodeURIComponent(me.company.logoUpdatedAt)}` : ""}`} alt={`${me.company.name} logo`} />
        )}
        {/* With a logo, the logo names the company; without one, the name shows instead. */}
        {!me.company.hasLogo && <div className="brand">{me.company.name}</div>}
        <div className="brand sidebar-company">Management Software</div>
        <Link href="/notifications" className={path.startsWith("/notifications") ? "active" : ""}>
          Notifications {unread > 0 && <span className="badge bad" style={{ marginLeft: 4 }}>{unread > 99 ? "99+" : unread}</span>}
        </Link>
        <Link href="/wiki" className={path.startsWith("/wiki") ? "active" : ""}>Company Wiki</Link>
        <div className="side-switch" role="tablist" aria-label="Menu">
          {SIDES.map((o) => (
            <button key={o.key} type="button" role="tab" aria-selected={side === o.key} onClick={() => switchTo(o.key)}>{o.label}</button>
          ))}
        </div>
        {visible(NAV[side]).map((s) => (
          <div key={s.section || "top"} style={{ display: "contents" }}>
            {s.section && <div className="navsection">{s.section}</div>}
            {s.items.map((i) => i.href === "/accounting" && booksUrl ? (
              <a key={i.href} href={booksUrl} target="_blank" rel="noopener noreferrer" title="Opens Bigcapital in a new tab">
                {i.label}
              </a>
            ) : (
              <Link key={i.href} href={i.href} className={path === i.href || path.startsWith(`${i.href}/`) || (i.label === "Payroll" && (path.startsWith("/pay-periods") || path.startsWith("/tax-forms"))) ? "active" : ""}>
                {i.label}
                {i.label === "Payroll" && !!payApprovals?.pending && <span className="badge warn" style={{ marginLeft: 4 }} title="Pay periods waiting for your approval">{payApprovals.pending}</span>}
              </Link>
            ))}
          </div>
        ))}
        <div className="spacer" />
        <div className="company" style={{ paddingBottom: 4 }}>
          {me.user.firstName} {me.user.lastName} · {me.user.role}
        </div>
        <Link href="/help" className={`nav-help ${path.startsWith("/help") ? "active" : ""}`}><span aria-hidden="true">?</span> Help</Link>
        <Link href="/settings/security" className={path.startsWith("/settings") ? "active" : ""}>Settings</Link>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut().then(() => router.replace("/login")); }}>
          Sign Out
        </a>
      </nav>
      <main className="main"><PageLayoutRoot>{children}</PageLayoutRoot></main>
    </div>
  );
}
