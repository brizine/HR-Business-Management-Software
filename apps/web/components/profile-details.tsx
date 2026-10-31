"use client";
import { useEffect, useState } from "react";
import { PROFILE_FIELDS, ageOn, type ProfileFieldKey } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
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

/**
 * The employee's details, in the company's order. The owner can drag them right here to
 * rearrange; the new order saves as soon as they drop and applies to every employee page.
 */
export function ProfileDetails({ e, order, canArrange = false, onReordered }: { e: any; order: ProfileFieldKey[]; canArrange?: boolean; onReordered?: (order: ProfileFieldKey[]) => void }) {
  const [list, setList] = useState(order);
  const [dragging, setDragging] = useState<ProfileFieldKey | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setList(order), [order]);

  const moveOver = (target: ProfileFieldKey) => {
    if (!dragging || dragging === target) return;
    setList((l) => {
      const next = l.filter((k) => k !== dragging);
      next.splice(next.indexOf(target) + (l.indexOf(dragging) < l.indexOf(target) ? 1 : 0), 0, dragging);
      return next;
    });
  };
  const save = async () => {
    setDragging(null);
    if (list.join() === order.join()) return;
    setStatus("Saving…");
    try {
      const res = await api<{ order: ProfileFieldKey[] }>("/employees/field-order", { method: "PUT", body: { order: list } });
      onReordered?.(res.order);
      setStatus("Order saved for every employee page.");
    } catch (err) {
      setList(order);
      setStatus((err as Error).message);
    }
  };

  return (
    <>
      {canArrange && (
        <div className="muted arrange-hint" role="status">
          {status ?? "Owner: drag any detail by its ⠿ handle to change the order on every employee page."}
        </div>
      )}
      <div className={`formgrid${canArrange ? " arrangeable" : ""}`}>
        {list.map((key) => {
          const v = value(key, e);
          if (v === null || v === undefined) return null;
          return canArrange ? (
            <div
              key={key}
              draggable
              className={`arrange-item${dragging === key ? " dragging" : ""}`}
              onDragStart={(ev) => { setDragging(key); setStatus(null); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", key); }}
              onDragOver={(ev) => { ev.preventDefault(); moveOver(key); }}
              onDrop={(ev) => ev.preventDefault()}
              onDragEnd={save}
            >
              <div className="muted"><span className="drag-handle" aria-hidden="true">⠿</span> {LABELS[key]}</div>
              {v}
            </div>
          ) : (
            <div key={key}><div className="muted">{LABELS[key]}</div>{v}</div>
          );
        })}
      </div>
    </>
  );
}

/** Owner only: drag the details into the order everyone sees on employee pages. Arrow buttons do the same without a mouse. */
export function FieldOrderEditor({ order, onSaved }: { order: ProfileFieldKey[]; onSaved: (order: ProfileFieldKey[]) => void }) {
  const [list, setList] = useState(order);
  const [dragging, setDragging] = useState<ProfileFieldKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setList(order), [order]);
  const changed = list.join() !== order.join();

  const move = (key: ProfileFieldKey, to: number) => {
    setSaved(false);
    setList((l) => {
      const next = l.filter((k) => k !== key);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, key);
      return next;
    });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ order: ProfileFieldKey[] }>("/employees/field-order", { method: "PUT", body: { order: list } });
      onSaved(res.order);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field-order">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Field order</strong> <span className="muted">(owner only · applies to every employee page)</span>
          <div className="muted" style={{ fontSize: 13 }}>Drag the details into the order you want, then Save order.</div>
        </div>
        <div className="row">
          <button type="button" className="btn sm" disabled={busy} onClick={() => { setList(PROFILE_FIELDS.map((f) => f.key)); setSaved(false); }}>Reset to default</button>
          <button type="button" className="btn sm primary" disabled={busy || !changed} onClick={save}>{busy ? "Saving…" : "Save order"}</button>
          {saved && !changed && <span className="muted" role="status">Saved.</span>}
        </div>
      </div>
      <ol className="field-order-list" aria-label="Field order">
        {list.map((key, i) => (
          <li
            key={key}
            draggable
            className={dragging === key ? "dragging" : undefined}
            onDragStart={(ev) => { setDragging(key); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", key); }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(ev) => {
              ev.preventDefault();
              if (dragging && dragging !== key) move(dragging, i);
            }}
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
    </div>
  );
}
