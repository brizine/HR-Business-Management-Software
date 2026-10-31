"use client";
import { useEffect, useState } from "react";
import { PROFILE_FIELDS, ageOn, type ProfileFieldKey } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Badge, ErrorBox } from "./ui";

const LABELS = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f.label])) as Record<ProfileFieldKey, string>;

/** One detail's value, or null when this viewer can't see it (or it doesn't apply). */
function value(key: ProfileFieldKey, e: any) {
  switch (key) {
    case "email": return e.email;
    case "phone": return e.phone ?? "—";
    case "role": return e.role;
    case "hireDate": return fmtDate(e.startDate);
    case "pay": return "payRateCents" in e ? `${money(e.payRateCents)} ${e.payType === "hourly" ? "/hr" : "/yr"}` : null;
    case "employment": return e.employmentType?.replace("_", " ");
    case "login": return e.hasLogin ? "Yes" : "Not set";
    case "twoFactor": return "twoFactorEnabled" in e ? (e.twoFactorEnabled ? "On" : "Off") : null;
    case "signIn": return e.locked ? <Badge value="locked" /> : null;
    case "dateOfBirth": return "dateOfBirth" in e ? (e.dateOfBirth ? `${fmtDate(e.dateOfBirth)} (age ${ageOn(e.dateOfBirth)})` : "—") : null;
    case "address": {
      if (!("addressLine1" in e)) return null;
      const street = [e.addressLine1, e.addressLine2].filter(Boolean).join(", ");
      const cityLine = [e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return street || cityLine ? <>{street}{street && cityLine && <br />}{cityLine}</> : "—";
    }
    case "emergency":
      if (!("emergencyName" in e)) return null;
      return e.emergencyName || e.emergencyPhone ? (
        <>
          {e.emergencyName ?? ""}{e.emergencyRelationship ? ` (${e.emergencyRelationship})` : ""}
          {e.emergencyPhone && <div><a href={`tel:${e.emergencyPhone}`}>{e.emergencyPhone}</a></div>}
        </>
      ) : "—";
  }
}

/** The employee's details, in the company's order (the owner sets it in Settings → Company). */
export function ProfileDetails({ e, order }: { e: any; order: ProfileFieldKey[] }) {
  return (
    <div className="formgrid">
      {order.map((key) => {
        const v = value(key, e);
        return v === null || v === undefined ? null : <div key={key}><div className="muted">{LABELS[key]}</div>{v}</div>;
      })}
    </div>
  );
}

/**
 * Owner, in Settings → Company: drag the details into the order every employee page uses.
 * ↑ ↓ do the same without a mouse.
 */
export function EmployeeLayoutEditor() {
  const saved = useApi<{ order: ProfileFieldKey[] }>("/employees/field-order");
  const [list, setList] = useState<ProfileFieldKey[] | null>(null);
  const [dragging, setDragging] = useState<ProfileFieldKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { if (saved.data) setList(saved.data.order); }, [saved.data]);
  if (!list || !saved.data) return <ErrorBox error={saved.error} />;
  const changed = list.join() !== saved.data.order.join();

  const move = (key: ProfileFieldKey, to: number) => {
    setDone(false);
    setList((l) => {
      const next = l!.filter((k) => k !== key);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, key);
      return next;
    });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      saved.setData(await api<{ order: ProfileFieldKey[] }>("/employees/field-order", { method: "PUT", body: { order: list } }));
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Employee page layout</h2>
      <p className="muted" style={{ margin: 0 }}>The order of the details on every employee&apos;s page. Drag them by the ⠿ handle (or use ↑ ↓), then Save. People still only see the details they&apos;re allowed to.</p>
      <ol className="field-order-list" aria-label="Employee page layout">
        {list.map((key, i) => (
          <li
            key={key}
            draggable
            className={dragging === key ? "dragging" : undefined}
            onDragStart={(ev) => { setDragging(key); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", key); }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(ev) => { ev.preventDefault(); if (dragging && dragging !== key) move(dragging, i); }}
            onDrop={(ev) => ev.preventDefault()}
          >
            <span className="drag-handle" aria-hidden="true">⠿</span>
            <span className="field-order-num">{i + 1}</span>
            <span style={{ flex: 1 }}>{LABELS[key]}</span>
            <button type="button" className="btn sm" aria-label={`Move ${LABELS[key]} up`} disabled={i === 0} onClick={() => move(key, i - 1)}>↑</button>
            <button type="button" className="btn sm" aria-label={`Move ${LABELS[key]} down`} disabled={i === list.length - 1} onClick={() => move(key, i + 1)}>↓</button>
          </li>
        ))}
      </ol>
      <ErrorBox error={error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !changed} onClick={save}>{busy ? "Saving…" : "Save layout"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setList(PROFILE_FIELDS.map((f) => f.key)); setDone(false); }}>Reset to default</button>
        {changed && <button type="button" className="btn" disabled={busy} onClick={() => setList(saved.data!.order)}>Undo changes</button>}
        {done && !changed && <span className="muted" role="status">Saved. Every employee page now uses this order.</span>}
      </div>
    </div>
  );
}
