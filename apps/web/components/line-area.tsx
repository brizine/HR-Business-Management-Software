"use client";
import { areaFieldId, lawnAreaNote, lineSqFt, sizeChoices, type LawnArea, type LawnSizes } from "@crewdesk/shared";
import { useCustomFields } from "./custom-fields";

/**
 * Which of the property's sizes a line item is priced from. The sizes are the property's number
 * fields (Total ft, Front Lawn ft, Back Lawn ft, Other ft, and any the company added); the service
 * says which one its lines start on, and a line can use another, or a size typed in, for one
 * customer (flea & tick only in the back yard where the dog is). The same picker is on work order,
 * estimate and invoice lines; the line's price is worked out from the size it shows.
 */

/** A line's size while it's being edited (the typed size as text). */
export type AreaDraft = { lawnArea: LawnArea; lawnAreaSqFt: string };
export const wholeLawn = (): AreaDraft => ({ lawnArea: "whole", lawnAreaSqFt: "" });
export const areaDraft = (l?: { lawnArea?: string | null; lawnAreaSqFt?: number | null } | null): AreaDraft => ({
  lawnArea: l?.lawnArea || "whole",
  lawnAreaSqFt: l?.lawnAreaSqFt != null ? String(Math.round(l.lawnAreaSqFt)) : "",
});
/** As the server takes it: the typed size only for "custom". */
export const areaValue = (a: AreaDraft): { lawnArea: LawnArea; lawnAreaSqFt: number | null } => {
  const typed = Number(a.lawnAreaSqFt.replace(/[,\s]/g, ""));
  return { lawnArea: a.lawnArea, lawnAreaSqFt: a.lawnArea === "custom" && Number.isFinite(typed) && typed > 0 ? typed : null };
};
/** The size a draft line is priced from at a property (null: not known yet). */
export const draftSqFt = (a: AreaDraft, property: LawnSizes | null | undefined) => lineSqFt(areaValue(a), property);

type AreaService = { pricing?: string; chemical?: boolean | null; minutesPer1000?: number | null; products?: unknown[]; defaultLawnArea?: string | null };
/** Whether the size matters for a service's line: its price, its time or what it puts down depends on it. */
export const usesLawnArea = (s: AreaService | null | undefined) => !!s && (s.pricing !== "flat" || !!s.chemical || s.minutesPer1000 != null || (s.products?.length ?? 0) > 0);
/** The size a service's lines start on. */
export const serviceArea = (s: AreaService | null | undefined): AreaDraft => areaDraft({ lawnArea: s?.defaultLawnArea ?? "whole" });

/** Until the company's fields have loaded: Crewdesk's own four sizes under their usual names. */
const USUAL = [{ key: "whole", name: "Total ft" }, { key: "front", name: "Front Lawn ft" }, { key: "back", name: "Back Lawn ft" }, { key: "other", name: "Other ft" }];
export type Sizes = { choices: { key: string; name: string }[]; names: Record<string, string> };
/** The property sizes a service or a line can be priced from, by the names the company gave them. Load once per form. */
export function useSizes(): Sizes {
  const fields = useCustomFields("property");
  const found = sizeChoices(fields.data ?? []);
  const choices = found.length ? found : USUAL;
  return { choices, names: Object.fromEntries(choices.map((c) => [c.key, c.name])) };
}

const n = (v: number) => (Math.round(v * 100) / 100).toLocaleString("en-US");

export function LineAreaPicker({ value, onChange, property, label, sizes }: { value: AreaDraft; onChange: (a: AreaDraft) => void; property: LawnSizes | null | undefined; label: string; sizes: Sizes }) {
  const size = (lawnArea: string) => {
    const v = lineSqFt({ lawnArea }, property);
    return v ? `: ${n(v)}` : property ? ": not on file" : "";
  };
  const known = value.lawnArea === "custom" || sizes.choices.some((c) => c.key === value.lawnArea);
  const blank = value.lawnArea !== "custom" && !!property && !lineSqFt({ lawnArea: value.lawnArea }, property);
  return (
    <div className="line-area">
      <select aria-label={label} title="The property size this line is priced from. Its price, time and product amounts are worked out from it." value={value.lawnArea}
        onChange={(e) => onChange({ lawnArea: e.target.value, lawnAreaSqFt: e.target.value === "custom" ? value.lawnAreaSqFt : "" })}>
        {sizes.choices.map((c) => <option key={c.key} value={c.key}>{c.name}{size(c.key)}</option>)}
        {!known && <option value={value.lawnArea}>{areaFieldId(value.lawnArea) ? "A field that's been deleted" : value.lawnArea}{size(value.lawnArea)}</option>}
        <option value="custom">A size you type…</option>
      </select>
      {value.lawnArea === "custom" && <input aria-label={`${label}, sq ft`} inputMode="numeric" placeholder="sq ft" value={value.lawnAreaSqFt} onChange={(e) => onChange({ ...value, lawnAreaSqFt: e.target.value.replace(/[^\d,.]/g, "") })} />}
      {blank && value.lawnArea !== "whole" && <span className="muted">Nothing in {sizes.names[value.lawnArea] ?? "that field"} for this property. Add it on the property, or type a size.</span>}
    </div>
  );
}

/**
 * What to show after a saved line's wording: "back lawn only, 6,800" (just the size when the
 * wording already says which part; nothing for the whole lawn).
 */
export function areaSummary(l: { description?: string; lawnArea?: string | null; lawnAreaSqFt?: number | null }, property: LawnSizes | null | undefined, names?: Record<string, string>): string {
  const note = lawnAreaNote(l, names);
  if (!note && (l.lawnArea ?? "whole") === "whole") return "";
  const v = l.lawnArea === "custom" ? null : lineSqFt(l, property);
  const said = !!note && (l.description ?? "").toLowerCase().includes(note);
  return [said ? "" : note, v ? `${n(v)} sq ft` : ""].filter(Boolean).join(", ");
}
