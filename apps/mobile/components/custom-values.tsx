import { formatCustomValue, type CustomFieldDef, type CustomFieldTarget, type CustomValues } from "@crewdesk/shared";
import { useApi } from "@/lib/hooks";
import { Txt } from "./ui";

/** The company's custom fields (all kinds), loaded once per card. */
export const useCustomFieldDefs = () => useApi<CustomFieldDef[]>("/custom-fields");

/** A record's filled-in custom values, one muted line each ("Front Yard Sq Ft: 4,200"). */
export function CustomLines({ defs, target, values }: { defs: CustomFieldDef[] | null; target: CustomFieldTarget; values: CustomValues | null | undefined }) {
  const shown = (defs ?? []).filter((f) => f.appliesTo === target && values && values[f.id] !== undefined && values[f.id] !== null && values[f.id] !== "");
  return <>{shown.map((f) => <Txt key={f.id} muted>{f.name}: {formatCustomValue(f, values?.[f.id])}</Txt>)}</>;
}
