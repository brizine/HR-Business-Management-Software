"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AUTOMATION_ACTIONS, actionLabel, triggerDef, triggerLabel, triggerListFor, triggerWorksAs,
  type ActionDef, type ActionKey, type AutomationAction, type AutomationCond, type AutomationDef, type TriggerUse,
} from "@crewdesk/shared";
import { useApi } from "@/lib/hooks";
import { Icon } from "@/components/icons";

/** The pieces the Automations screens share, shaped like Homeworks' (pill tabs, On/Off pills, plain selects, Yes/No dialog). */

export type Automation = {
  id: string; number: number; kind: "simple" | "sequence"; name: string; description: string | null; labels: string[]; enabled: boolean; review: boolean;
  def: AutomationDef; imported: string | null; wasOn: boolean | null; locked: boolean; problems: string[]; cannotTurnOn: string | null; deadBlocks: { index: number; why: string }[];
  counts: { running: number; review: number; done: number; skipped: number; lastAt: string | null };
};
export type Options = {
  templates: { id: string; name: string; channel: "email" | "text"; audience: "customer" | "internal" }[];
  tags: { id: string; name: string; color: string }[];
  categories: { id: string; name: string }[];
  services: { id: string; name: string }[];
  employees: { id: string; name: string; owner: boolean }[];
  automations: { id: string; number: number; name: string; kind: string }[];
};
export const useAutomationOptions = () => useApi<Options>("/automations/options");

export const PLEASE = "--- Please Select ---";
export const actionOf = (k: string) => (AUTOMATION_ACTIONS as Record<string, ActionDef>)[k] as ActionDef | undefined;
export const blankCond = (key = ""): AutomationCond => ({ key, tagIds: [], categoryIds: [], serviceIds: [] });
/** "Nov 25, 2026 9:03 am", as Homeworks writes dates. */
export const hwDate = (s: string | null | undefined) => {
  if (!s) return "";
  const d = new Date(s);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()}`;
};

/** Homeworks' red star on a required field. */
export const Req = () => <em className="hw-req" aria-hidden="true"> *</em>;
export function Field({ label, required, children, half, className }: { label: ReactNode; required?: boolean; children: ReactNode; half?: boolean; className?: string }) {
  return (
    <label className={`hw-field ${half ? "half" : ""} ${className ?? ""}`}>
      <span className="hw-label">{label}{required && <Req />}</span>
      {children}
    </label>
  );
}

/** Homeworks' On / Off pill: dark with the knob on the right when on, light with it on the left when off. */
export function HwToggle({ on, onChange, disabled, label, title }: { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean; label: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled} className={`hw-toggle ${on ? "on" : "off"}`} onClick={() => onChange?.(!on)}>
      <span className="hw-toggle-text">{on ? "On" : "Off"}</span>
      <span className="hw-toggle-knob" aria-hidden="true" />
    </button>
  );
}

/** Homeworks' Yes / No box ("Delete Automation — Are you sure you want to delete this Automation?"). */
export function ConfirmDialog({ title, message, onYes, onNo, busy }: { title: string; message: ReactNode; onYes: () => void; onNo: () => void; busy?: boolean }) {
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    no.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onNo(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onNo]);
  return (
    <div className="hw-dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onNo(); }}>
      <div className="hw-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="hw-dialog-head"><span>{title}</span><button type="button" className="hw-dialog-x" aria-label="Close" onClick={onNo}>×</button></div>
        <div className="hw-dialog-body">{message}</div>
        <div className="hw-dialog-foot">
          <button type="button" className="btn primary" disabled={busy} onClick={onYes}>Yes</button>
          <button type="button" className="btn hw-soft" ref={no} onClick={onNo}>No</button>
        </div>
      </div>
    </div>
  );
}

/** Pencil and trash, as in Homeworks' Actions column. */
export function IconButton({ icon, label, onClick, danger, disabled, href }: { icon: "pencil" | "trash"; label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; href?: string }) {
  const cls = `hw-icon-btn ${danger ? "danger" : ""}`;
  if (href) return <a className={cls} href={href} aria-label={label} title={label}><Icon name={icon} size={17} /></a>;
  return <button type="button" className={cls} aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon} size={17} /></button>;
}

/**
 * A trigger list exactly as Homeworks has it (same triggers, same order, all selectable). What
 * Crewdesk can't do with a pick is said under it, not hidden.
 */
export function TriggerSelect({ use, value, onChange, label, placeholder = PLEASE }: { use: TriggerUse; value: string; onChange: (key: string) => void; label: string; placeholder?: string }) {
  const list = triggerListFor(use);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{placeholder}</option>
      {list.map((k) => <option key={k} value={k}>{triggerLabel(k, use)}</option>)}
      {value && !list.includes(value as never) && <option value={value}>{triggerLabel(value, use)}</option>}
    </select>
  );
}

/** Under a trigger: why Crewdesk can't run it, or that it doesn't fit there. */
export function TriggerNote({ k, use, inSequence }: { k: string; use: TriggerUse; inSequence?: boolean }) {
  const d = triggerDef(k);
  if (!d) return null;
  if ("na" in d && d.na) return <p className="hw-note">{d.na} {inSequence ? "This part won't run (the rest still does)." : "It can be saved, but it stays off."}</p>;
  if (!triggerWorksAs(k, use)) return <p className="hw-note bad">{use === "and" ? "This is something that happens, not a condition. Pick it as the trigger (or an ELSE Trigger) instead." : use === "stop" ? "Crewdesk can't stop on this one. Pick another." : "This is a condition, not something that happens. Add it with AND Condition instead."}</p>;
  return null;
}

/** The second pick under a trigger or condition: the tag, to-do category or service. */
export function CondParam({ cond, onChange, o }: { cond: AutomationCond; onChange: (c: AutomationCond) => void; o: Options }) {
  const p = triggerDef(cond.key)?.param;
  if (p === "tags") return <PickOne label="Tag" items={o.tags} value={cond.tagIds[0] ?? ""} onChange={(id) => onChange({ ...cond, tagIds: id ? [id] : [] })} />;
  if (p === "categories") return <PickOne label="Category" items={o.categories} value={cond.categoryIds[0] ?? ""} onChange={(id) => onChange({ ...cond, categoryIds: id ? [id] : [] })} />;
  if (p === "services") return <PickOne label="Service" items={o.services} value={cond.serviceIds[0] ?? ""} onChange={(id) => onChange({ ...cond, serviceIds: id ? [id] : [] })} />;
  return null;
}
export function PickOne({ label, items, value, onChange, placeholder = PLEASE }: { label: string; items: { id: string; name: string }[]; value: string; onChange: (id: string) => void; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{placeholder}</option>
      {items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

/** The email or text templates, in name order (Homeworks lists them all in one list). */
export function TemplateSelect({ channel, value, onChange, o }: { channel: "email" | "text"; value: string | null; onChange: (id: string | null) => void; o: Options }) {
  return <PickOne label={channel === "email" ? "Email Template" : "Text Template"} items={o.templates.filter((t) => t.channel === channel)} value={value ?? ""} onChange={(id) => onChange(id || null)} />;
}

/** "TEXT will be sent only between 09:00 AM to 06:00 PM". */
export const TextHours = () => <div className="hw-alert" role="note">TEXT will be sent only between <b>09:00 AM</b> to <b>06:00 PM</b></div>;

/** Homeworks' Tags box on an automation ("add a tag"): words to find it by. */
export function TagBox({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => { const t = draft.trim().replace(/,$/, ""); if (t && !value.includes(t)) onChange([...value, t].slice(0, 20)); setDraft(""); };
  return (
    <div className="hw-tagbox">
      {value.map((l) => <span key={l} className="hw-chip">{l}<button type="button" aria-label={`Remove ${l}`} onClick={() => onChange(value.filter((x) => x !== l))}>×</button></span>)}
      <input value={draft} placeholder="add a tag" maxLength={40} aria-label="Tags" onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1)); }} onBlur={add} />
    </div>
  );
}

/** Homeworks' Previous / 1 / Next. */
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const from = Math.max(1, Math.min(page - 2, pages - 4));
  const nums = Array.from({ length: Math.min(5, pages) }, (_, i) => from + i);
  return (
    <nav className="hw-pager" aria-label="Page navigation">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      {nums.map((n) => <button key={n} type="button" className={n === page ? "on" : ""} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>)}
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

/** What an action is, in Homeworks' words, for lists. */
export const actionText = (act: Pick<AutomationAction, "action">, simple = false) => actionLabel(act.action, simple);
export type { ActionKey };
