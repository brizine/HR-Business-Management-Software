"use client";
import type { ReactNode } from "react";

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone ? `var(--${tone})` : undefined;
  return (
    <div className="stat">
      <div className="v" style={{ color }}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

const TONES: Record<string, string> = {
  active: "ok", approved: "ok", completed: "ok", ok: "ok", hired: "ok", open: "ok", passed: "ok",
  pending: "warn", onboarding: "warn", due_soon: "warn", in_progress: "warn", waiting_parts: "warn",
  in_shop: "warn", medium: "warn", interview: "warn", offer: "warn", draft: "warn",
  denied: "bad", overdue: "bad", terminated: "bad", out_of_service: "bad", critical: "bad", high: "bad",
  rejected: "bad", failed: "bad", cancelled: "bad",
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className={`badge ${TONES[value] ?? ""}`}>{value.replace(/_/g, " ")}</span>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Reads a <form> into a plain object; numeric inputs become numbers, empty strings are dropped. */
export function formValues(form: HTMLFormElement): Record<string, any> {
  const out: Record<string, any> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.value === "") continue;
    else if (el.type === "number") out[el.name] = Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}
