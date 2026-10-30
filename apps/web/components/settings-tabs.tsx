"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsTabs() {
  const path = usePathname();
  const tab = (href: string, label: string) => (
    <Link href={href} className={`btn ${path === href ? "primary" : ""}`}>{label}</Link>
  );
  return (
    <div className="settings-tabs">
      {tab("/settings/profile", "My info")}
      {tab("/settings/security", "Security")}
      {tab("/settings/notifications", "Notifications")}
    </div>
  );
}
