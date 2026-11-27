"use client";
import { useEffect, useState } from "react";
import {
  NOTICE_CHANNELS, NOTICE_CHANNEL_LABELS, NOTIFY_BEFORE, NOTIFY_BEFORE_LABELS, followPropertyTotal, formatCustomValue, propertyFieldValues,
  type CustomFieldDef, type CustomValue, type CustomValues, type NotifyBefore,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { FieldInput, NewFieldModal, fieldsChanged, useCustomFields } from "./custom-fields";
import { TagChips } from "./customers";
import { Icon } from "./icons";
import { PropertyImage } from "./property-image";
import { ErrorBox } from "./ui";
import { CardExemptToggle } from "./waitlist";

/**
 * The Property box. Everything in it is one item in one grid, so the layout editor can move or hide
 * each: every custom field (Crewdesk's own, such as Map Code, Gate Code and the sizes, and the ones
 * the company added), the Property Image, the tags, the scheduling choices and the card-on-file
 * switch. Edit turns the fields into boxes to type in; Save writes them to the property.
 */

type Tag = Parameters<typeof TagChips>[0]["tags"][number];
type Property = {
  id: string; street: string; status: string; tagIds: string[]; custom?: CustomValues | null;
  mapCode: string | null; mapCodeManual: boolean; frontSqFt: number | null; backSqFt: number | null; otherSqFt: number | null; lawnSqFt: number | null;
  gateCode: string | null; pets: string | null; accessNotes: string | null; notes: string | null;
  measurementId: string | null; preferredCrewId?: string | null; notifyBefore?: NotifyBefore | null; chemicalNotice?: string | null;
  cardExemptReason?: string | null; cardExemptAt?: string | null;
};

/** Fields that read better across the whole box. */
const wide = (f: CustomFieldDef) => f.builtin === "accessNotes" || f.builtin === "notes";

export function PropertyBox({ property: p, tags, onSaved }: { property: Property; tags: Tag[]; onSaved: () => void }) {
  const { can } = useAuth();
  const admin = can("admin");
  const active = p.status !== "cancelled";
  const list = useCustomFields("property");
  const fields = list.data ?? [];
  const values = propertyFieldValues(fields, p);
  const [editing, setEditing] = useState<CustomValues | null>(null);
  const [adding, setAdding] = useState(false);
  const save = useAction();
  const act = useAction();
  const crews = useApi<{ id: string; name: string; active: boolean }[]>("/crews");
  const [reason, setReason] = useState("");
  const [exempting, setExempting] = useState(false);
  // Another property opened in the same box: drop any half-made edit.
  useEffect(() => { setEditing(null); }, [p.id]);

  const prefs = (patch: { notifyBefore?: NotifyBefore | null; preferredCrewId?: string | null }) => act.run(async () => {
    await api(`/waitlist/property/${p.id}`, { method: "PUT", body: { notifyBefore: p.notifyBefore ?? null, preferredCrewId: p.preferredCrewId ?? null, ...patch } }); onSaved();
  });
  const exempt = (on: boolean) => act.run(async () => { await api("/waitlist/card-exempt", { method: "PUT", body: { propertyId: p.id, exempt: on, reason: on ? reason : undefined } }); setExempting(false); setReason(""); onSaved(); });
  const set = (id: string, v: CustomValue | "") => setEditing((cur) => (cur ? followPropertyTotal(fields, cur, { ...cur, [id]: v }) : cur));

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Property</h2>
        <div className="row">
          {active && !editing && fields.length > 0 && <button type="button" className="btn" title="Change this property's details: Map Code, sizes, Gate Code and your own fields" onClick={() => setEditing({ ...values })}>Edit details</button>}
          {admin && !editing && <button type="button" className="btn" title="Add your own field to every property" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add custom field</button>}
        </div>
      </div>
      <div className="grid prop-items">
        {fields.map((f) => {
          const v = editing ? editing[f.id] : values[f.id];
          return (
            <div key={f.id} className={`prop-item${wide(f) ? " wide" : ""}`} aria-label={f.name}>
              <label className="prop-label" htmlFor={editing ? `cf-${f.id}` : undefined}>{f.name}</label>
              {editing ? <FieldInput f={f} value={v} onChange={(x) => set(f.id, x)} /> : (
                <div className="prop-value">
                  {formatCustomValue(f, v) || <span className="muted">—</span>}
                  {f.builtin === "mapCode" && p.mapCode && p.mapCodeManual && <span className="muted"> (set by hand)</span>}
                </div>
              )}
            </div>
          );
        })}
        {editing && (
          <div className="prop-item wide" aria-label="Save details">
            <ErrorBox error={save.error} />
            <div className="row">
              <button type="button" className="btn primary" disabled={save.busy} onClick={() => save.run(async () => {
                // Every field is sent, so one that was emptied is cleared.
                await api(`/custom-fields/values/property/${p.id}`, { method: "PUT", body: { values: Object.fromEntries(fields.map((f) => [f.id, editing[f.id] ?? ""])) } });
                setEditing(null); onSaved();
              })}>{save.busy ? "Saving…" : "Save details"}</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <span className="muted" style={{ fontSize: 13 }}>Total ft follows the front, back and other sizes until you type your own.</span>
            </div>
          </div>
        )}
        <div className="prop-item wide" aria-label="Property Image">
          <div className="prop-label">Property Image</div>
          <PropertyImage property={p} canEdit={active} onChanged={onSaved} />
        </div>
        <div className="prop-item" aria-label="Tags">
          <div className="prop-label">Tags</div>
          <div className="prop-value"><TagChips ids={p.tagIds} tags={tags} />{!p.tagIds.length && <span className="muted">—</span>}</div>
        </div>
        <div className="prop-item" aria-label="Preferred crew">
          <label className="prop-label" htmlFor="prop-crew">Preferred crew</label>
          <select id="prop-crew" value={p.preferredCrewId ?? ""} disabled={act.busy} onChange={(e) => prefs({ preferredCrewId: e.target.value || null })}>
            <option value="">None</option>
            {(crews.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="prop-item" aria-label="Pre Visit Notification">
          <label className="prop-label" htmlFor="prop-notify">Pre Visit Notification</label>
          <select id="prop-notify" value={p.notifyBefore ?? ""} disabled={act.busy} onChange={(e) => prefs({ notifyBefore: (e.target.value || null) as NotifyBefore | null })}>
            <option value="">Same as the customer</option>
            {NOTIFY_BEFORE.map((x) => <option key={x} value={x}>{NOTIFY_BEFORE_LABELS[x]}</option>)}
          </select>
        </div>
        <div className="prop-item" aria-label="After a chemical application">
          <label className="prop-label" htmlFor="prop-chem">After a chemical application</label>
          <select id="prop-chem" value={p.chemicalNotice ?? "email"} disabled={act.busy}
            onChange={(e) => act.run(async () => { await api(`/properties/${p.id}/chemical-notice`, { method: "PUT", body: { chemicalNotice: e.target.value } }); onSaved(); })}>
            {NOTICE_CHANNELS.map((c) => <option key={c} value={c}>{NOTICE_CHANNEL_LABELS[c]}</option>)}
          </select>
        </div>
        <div className="prop-item wide" aria-label="Card on file">
          <CardExemptToggle what="property" on={!!p.cardExemptAt} reason={p.cardExemptReason ?? ""} placeholder="Why (e.g. commercial account, net 30)" busy={act.busy}
            exempting={exempting} setExempting={setExempting} draft={reason} setDraft={setReason} onSave={exempt} />
        </div>
      </div>
      <ErrorBox error={act.error} />
      {adding && <NewFieldModal appliesTo="property" onClose={() => setAdding(false)} onSaved={() => { setAdding(false); fieldsChanged(); }} />}
    </div>
  );
}
