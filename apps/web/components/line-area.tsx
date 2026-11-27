"use client";
import { LAWN_AREAS, LAWN_AREA_LABELS, lawnAreaNote, lineSqFt, type LawnArea, type LawnSizes } from "@crewdesk/shared";

/**
 * Which part of the lawn a line item is for: the whole lawn, the front, the back, or a size typed
 * in (a customer who only wants flea & tick in the back yard where the dog is). The same picker on
 * work order, estimate and invoice lines; the line's price is worked out from the size it shows.
 */

/** A line's area while it's being edited (the typed size as text). */
export type AreaDraft = { lawnArea: LawnArea; lawnAreaSqFt: string };
export const wholeLawn = (): AreaDraft => ({ lawnArea: "whole", lawnAreaSqFt: "" });
export const areaDraft = (l?: { lawnArea?: string | null; lawnAreaSqFt?: number | null } | null): AreaDraft => ({
  lawnArea: (LAWN_AREAS as readonly string[]).includes(l?.lawnArea ?? "") ? (l!.lawnArea as LawnArea) : "whole",
  lawnAreaSqFt: l?.lawnAreaSqFt != null ? String(Math.round(l.lawnAreaSqFt)) : "",
});
/** As the server takes it: the typed size only for "custom". */
export const areaValue = (a: AreaDraft): { lawnArea: LawnArea; lawnAreaSqFt: number | null } => {
  const typed = Number(a.lawnAreaSqFt.replace(/[,\s]/g, ""));
  return { lawnArea: a.lawnArea, lawnAreaSqFt: a.lawnArea === "custom" && Number.isFinite(typed) && typed > 0 ? typed : null };
};
/** The square feet a draft line covers at a property (null: not known yet). */
export const draftSqFt = (a: AreaDraft, property: LawnSizes | null | undefined) => lineSqFt(areaValue(a), property);

type AreaService = { pricing?: string; chemical?: boolean | null; minutesPer1000?: number | null; products?: unknown[]; defaultLawnArea?: string | null };
/** Whether the size matters for a service's line: its price, its time or what it puts down depends on it. */
export const usesLawnArea = (s: AreaService | null | undefined) => !!s && (s.pricing !== "flat" || !!s.chemical || s.minutesPer1000 != null || (s.products?.length ?? 0) > 0);
/** The area a service's lines start on. */
export const serviceArea = (s: AreaService | null | undefined): AreaDraft => areaDraft({ lawnArea: s?.defaultLawnArea ?? "whole" });

const n = (v: number) => Math.round(v).toLocaleString("en-US");

export function LineAreaPicker({ value, onChange, property, label }: { value: AreaDraft; onChange: (a: AreaDraft) => void; property: LawnSizes | null | undefined; label: string }) {
  const size = (lawnArea: LawnArea) => {
    const v = lineSqFt({ lawnArea }, property);
    return v ? ` · ${n(v)} sq ft` : property ? " · size not on file" : "";
  };
  const unknown = value.lawnArea !== "custom" && property && !lineSqFt({ lawnArea: value.lawnArea }, property);
  return (
    <div className="line-area">
      <select aria-label={label} title="The part of the lawn this line is for. Its price, time and product amounts are worked out from that size." value={value.lawnArea}
        onChange={(e) => onChange({ lawnArea: e.target.value as LawnArea, lawnAreaSqFt: e.target.value === "custom" ? value.lawnAreaSqFt : "" })}>
        <option value="whole">{LAWN_AREA_LABELS.whole}{size("whole")}</option>
        <option value="front">{LAWN_AREA_LABELS.front}{size("front")}</option>
        <option value="back">{LAWN_AREA_LABELS.back}{size("back")}</option>
        <option value="custom">A size you type…</option>
      </select>
      {value.lawnArea === "custom" && <input aria-label={`${label}, sq ft`} inputMode="numeric" placeholder="sq ft" value={value.lawnAreaSqFt} onChange={(e) => onChange({ ...value, lawnAreaSqFt: e.target.value.replace(/[^\d,.]/g, "") })} />}
      {unknown && value.lawnArea !== "whole" && <span className="muted">Add the {value.lawnArea} lawn size on the property, or type a size.</span>}
    </div>
  );
}

/**
 * What to show after a saved line's wording: "back lawn only, 6,800 sq ft" (just the size when the
 * wording already says which part; nothing for the whole lawn).
 */
export function areaSummary(l: { description?: string; lawnArea?: string | null; lawnAreaSqFt?: number | null }, property: LawnSizes | null | undefined): string {
  const note = lawnAreaNote(l);
  if (!note) return "";
  const v = l.lawnArea === "custom" ? null : lineSqFt(l, property);
  const said = (l.description ?? "").toLowerCase().includes(note);
  return [said ? "" : note, v ? `${n(v)} sq ft` : ""].filter(Boolean).join(", ");
}
