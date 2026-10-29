"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Role } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";

const NAV: { section: string; items: { href: string; label: string; min?: Role }[] }[] = [
  { section: "", items: [{ href: "/dashboard", label: "Dashboard", min: "manager" }] },
  {
    section: "People",
    items: [
      { href: "/people", label: "Team" },
      { href: "/schedule", label: "Schedule" },
      { href: "/time", label: "Time clock" },
      { href: "/time-off", label: "Time off" },
      { href: "/documents", label: "Documents" },
      { href: "/onboarding", label: "Onboarding" },
      { href: "/hiring", label: "Hiring", min: "manager" },
      { href: "/payroll", label: "Payroll", min: "admin" },
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

  useEffect(() => {
    if (ready && !me) router.replace("/login");
  }, [ready, me, router]);
  if (!me) return null;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Crewdesk</div>
        <div className="company">{me.company.name}</div>
        <Link href="/notifications" className={path.startsWith("/notifications") ? "active" : ""}>
          Notifications {unread > 0 && <span className="badge bad" style={{ marginLeft: 4 }}>{unread > 99 ? "99+" : unread}</span>}
        </Link>
        {NAV.map((s) => (
          <div key={s.section} style={{ display: "contents" }}>
            {s.section && <div className="navsection">{s.section}</div>}
            {s.items
              .filter((i) => !i.min || can(i.min))
              .map((i) => (
                <Link key={i.href} href={i.href} className={path.startsWith(i.href) ? "active" : ""}>
                  {i.label}
                </Link>
              ))}
          </div>
        ))}
        <div className="spacer" />
        <div className="company" style={{ paddingBottom: 4 }}>
          {me.user.firstName} {me.user.lastName} · {me.user.role}
        </div>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut(); router.replace("/login"); }}>
          Sign out
        </a>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
