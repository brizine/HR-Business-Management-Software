"use client";
import Link from "next/link";
import { useMenuData } from "@/lib/menus";

/** The owner's editable lists (Edit drop-down menus in the layout editor). */
export const useMenus = () => useMenuData().menus;

/**
 * A drop-down of the owner's list. Someone's current value stays selectable even if it was
 * taken off the list, so saving their record doesn't change it by accident.
 */
export function MenuSelect({ name, label, options, current, required, blank = true }: { name: string; label: string; options: string[]; current?: string | null; required?: boolean; blank?: boolean }) {
  const extra = current && !options.includes(current) ? current : null;
  return (
    <label>{label}
      <select name={name} defaultValue={current ?? (blank ? "" : options[0])} required={required} key={`${options.join("|")}:${current ?? ""}`}>
        {blank && <option value="">—</option>}
        {options.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
        {extra && <option value={extra}>{extra.replace(/_/g, " ")} (not on the list)</option>}
      </select>
      {!options.length && <span className="muted" style={{ fontSize: 12 }}>No choices yet. The owner adds them with Edit drop-down menus in the <Link href="/settings/company">layout editor</Link>.</span>}
    </label>
  );
}

/** A drop-down of fixed choices, worded the way the owner set (e.g. employment type). */
export function LabeledSelect({ menu, values, ...props }: { menu: Parameters<ReturnType<typeof useMenuData>["label"]>[0]; values: readonly string[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { label } = useMenuData();
  return <select {...props}>{values.map((v) => <option key={v} value={v}>{label(menu, v)}</option>)}</select>;
}
