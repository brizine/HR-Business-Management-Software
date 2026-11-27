"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Empty } from "@/components/ui";

const WEATHER = "/chemical-tracking/weather";
const TABS: [string, string][] = [
  ["/chemical-tracking", "Records"],
  ["/chemical-tracking/load-sheet", "Load sheet"],
  ["/chemical-tracking/notices", "Customer notices"],
  ["/chemical-tracking/weather", "Weather"],
  ["/chemical-tracking/products", "Products"],
  ["/chemical-tracking/mixes", "Mixes"],
  ["/chemical-tracking/methods", "Application methods"],
  ["/chemical-tracking/services", "Services"],
  ["/chemical-tracking/applicators", "Applicators & license"],
  ["/chemical-tracking/access", "Access"],
];

/**
 * Chemical Tracking (Resources): everything the state records draw on, in one place that only
 * admins and the people they add can open. The Spray Mix Calculator stays the techs' tank tool.
 *
 * Weather is the one tab with its own rule: it is the office's page (Customers & billing managers),
 * as it was under Field. So the tab shows only to them, and a manager who isn't in Chemical Tracking
 * still opens it, by itself, from Resources.
 */
export default function ChemicalTrackingLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { me, ready, can } = useAuth();
  if (!ready || !me) return null;
  const office = can("manager", "customers");
  if (!me.access?.chemicalTracking) {
    if (office && path.startsWith(WEATHER)) return <>{children}</>;
    return <Empty>Chemical Tracking is limited to admins and the people they add. Ask an admin if you need it.</Empty>;
  }
  const active = (href: string) => (href === "/chemical-tracking" ? path === href || path.startsWith("/chemical-tracking/records") : path.startsWith(href));
  return (
    <>
      <div className="settings-tabs noprint">
        {TABS.filter(([href]) => href !== WEATHER || office).map(([href, label]) => <Link key={href} href={href} className={`btn ${active(href) ? "primary" : ""}`}>{label}</Link>)}
      </div>
      {children}
    </>
  );
}
