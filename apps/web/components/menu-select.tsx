"use client";
import Link from "next/link";
import { useApi } from "@/lib/hooks";

type Menus = { jobTitles: string[]; departments: string[] };

/** The owner's Job title and Department lists (Settings → Company). */
export const useMenus = () => useApi<Menus>("/employees/menus").data ?? { jobTitles: [], departments: [] };

/**
 * A drop-down of the owner's list. Someone's current value stays selectable even if it was
 * taken off the list, so saving their record doesn't change it by accident.
 */
export function MenuSelect({ name, label, options, current, required }: { name: string; label: string; options: string[]; current?: string | null; required?: boolean }) {
  const extra = current && !options.includes(current) ? current : null;
  return (
    <label>{label}
      <select name={name} defaultValue={current ?? ""} required={required} key={`${options.join("|")}:${current ?? ""}`}>
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {extra && <option value={extra}>{extra} (not on the list)</option>}
      </select>
      {!options.length && <span className="muted" style={{ fontSize: 12 }}>No choices yet. The owner adds them in <Link href="/settings/company">Settings → Company</Link>.</span>}
    </label>
  );
}
