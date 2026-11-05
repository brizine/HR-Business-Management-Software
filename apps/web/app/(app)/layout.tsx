"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";
import type { PermissionArea, Role } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { PageLayoutRoot } from "@/components/page-layout";

const NAV: { section: string; items: { href: string; label: string; min?: Role; area?: PermissionArea }[] }[] = [
  { section: "", items: [{ href: "/dashboard", label: "Dashboard", min: "manager", area: "dashboard" }, { href: "/wiki", label: "Company wiki" }, { href: "/spray-mix", label: "Spray Mix Calculator" }] },
  {
    section: "People",
    items: [
      { href: "/people", label: "Team" },
      { href: "/schedule", label: "Schedule" },
      { href: "/time", label: "Time clock" },
      { href: "/attendance", label: "Attendance" },
      { href: "/time-off", label: "Time off" },
      { href: "/reviews", label: "Reviews & discipline" },
      { href: "/documents", label: "Documents" },
      { href: "/tax-forms", label: "Pay & tax forms" },
      { href: "/onboarding", label: "Onboarding" },
      { href: "/hiring", label: "Hiring", min: "manager", area: "hiring" },
      { href: "/payroll", label: "Payroll", min: "admin", area: "payroll" },
    ],
  },
  {
    section: "Fleet & equipment",
    items: [
      { href: "/fleet", label: "Assets" },
      { href: "/work-orders", label: "Work orders" },
      { href: "/inspections", label: "Inspections" },
    ],
  },
];

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
  // Pay period approvers who aren't admins reach their approvals from the sidebar.
  const [payApprovals, setPayApprovals] = useState<{ isApprover: boolean; pending: number } | null>(null);
  useEffect(() => {
    if (me) api<{ isApprover: boolean; pending: number }>("/pay-periods/me").then(setPayApprovals, () => {});
  }, [me?.user.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // The browser tab shows the company's name (re-applied on navigation in case Next resets it).
  const companyName = me?.company.name;
  useEffect(() => {
    if (companyName) document.title = companyName;
  }, [companyName, path]);

  useEffect(() => {
    if (ready && !me) router.replace("/login");
  }, [ready, me, router]);
  if (!me) return null;

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
        {NAV.map((s) => (
          <div key={s.section} style={{ display: "contents" }}>
            {s.section && <div className="navsection">{s.section}</div>}
            {s.items
              .filter((i) => !i.min || can(i.min, i.area))
              .map((i) => (
                <Link key={i.href} href={i.href} className={path.startsWith(i.href) ? "active" : ""}>
                  {i.label}
                </Link>
              ))}
          </div>
        ))}
        {payApprovals?.isApprover && (
          <Link href="/pay-periods" className={path.startsWith("/pay-periods") ? "active" : ""}>
            Pay approvals {payApprovals.pending > 0 && <span className="badge warn" style={{ marginLeft: 4 }}>{payApprovals.pending}</span>}
          </Link>
        )}
        <div className="spacer" />
        <div className="company" style={{ paddingBottom: 4 }}>
          {me.user.firstName} {me.user.lastName} · {me.user.role}
        </div>
        <Link href="/settings/security" className={path.startsWith("/settings") ? "active" : ""}>Settings</Link>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut().then(() => router.replace("/login")); }}>
          Sign out
        </a>
      </nav>
      <main className="main"><PageLayoutRoot>{children}</PageLayoutRoot></main>
    </div>
  );
}
