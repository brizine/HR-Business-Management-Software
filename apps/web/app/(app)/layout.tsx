"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Role } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";

const NAV: { section: string; items: { href: string; label: string; min?: Role }[] }[] = [
  { section: "", items: [{ href: "/dashboard", label: "Dashboard", min: "manager" }] },
  {
    section: "People",
    items: [
      { href: "/people", label: "Team" },
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

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, ready, signOut, can } = useAuth();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (ready && !me) router.replace("/login");
  }, [ready, me, router]);
  if (!me) return null;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Crewdesk</div>
        <div className="company">{me.company.name}</div>
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
