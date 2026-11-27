"use client";
import Link from "next/link";
import { useState } from "react";
import { COMPASS, WEATHER_MODES, WEATHER_MODE_LABELS, WEATHER_SOURCE_LABELS, compass, compassDeg, visitNumber, windText, type WeatherMode, type WeatherSettings, type WeatherSource } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

export type Reading = { windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null; rainIn: number | null; note?: string | null };
export type WeatherRecord = {
  visitId: string; number: number; title: string; completedAt: string; date: string; services: string[];
  customer: { id: string; name: string }; property: { id: string; address: string; hasLocation: boolean } | null; finishedBy: string | null;
  gps: { lat: number; lng: number; accuracy: number | null } | null;
  weather: null | (Reading & {
    source: WeatherSource | null; observedAt: string | null; station: string | null; enteredBy: string | null; tries: number; lastError: string | null;
  });
  needsWeather: boolean;
};
export type WeatherDay = Reading & { id: string; date: string; enteredById: string | null; updatedAt: string };

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dayOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "8 mph SSW, gusts 15 · 77°F · 0.10 in rain" */
export function readingText(r: Reading) {
  return [windText(r), r.tempF != null ? `${Math.round(r.tempF)}°F` : "", r.rainIn != null ? `${r.rainIn.toFixed(2)} in rain (24 h)` : ""].filter(Boolean).join(" · ");
}

/** Where a reading came from. */
export function sourceText(w: NonNullable<WeatherRecord["weather"]>) {
  if (w.source === "auto") return `${WEATHER_SOURCE_LABELS.auto}: ${w.station ?? "weather station"}${w.observedAt ? ` at ${timeOf(w.observedAt)}` : ""}`;
  if (w.source === "day") return `${WEATHER_SOURCE_LABELS.day}${w.enteredBy ? ` (${w.enteredBy})` : ""}`;
  if (w.source === "office") return `${WEATHER_SOURCE_LABELS.office}${w.enteredBy ? ` (${w.enteredBy})` : ""}`;
  return "";
}

/** Wind, direction, gusts, temperature, 24-hour rain and a note. */
export function WeatherForm({ initial, submitLabel, onSubmit, onCancel, busy, error }: {
  initial?: Partial<Reading> | null; submitLabel: string; onSubmit: (r: Record<string, unknown>) => void; onCancel?: () => void; busy: boolean; error: string | null;
}) {
  const [wind, setWind] = useState(initial?.windMph != null ? String(initial.windMph) : "");
  const [dir, setDir] = useState(compass(initial?.windDeg) ?? "");
  const [gust, setGust] = useState(initial?.gustMph != null ? String(initial.gustMph) : "");
  const [temp, setTemp] = useState(initial?.tempF != null ? String(Math.round(initial.tempF)) : "");
  const [rain, setRain] = useState(initial?.rainIn != null ? String(initial.rainIn) : "");
  const [note, setNote] = useState(initial?.note ?? "");
  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); onSubmit({ windMph: wind, windDeg: dir ? compassDeg(dir) : null, gustMph: gust, tempF: temp, rainIn: rain, note }); }}>
      <div className="formgrid wx-grid">
        <label>Wind (mph) *<input inputMode="decimal" required value={wind} onChange={(e) => setWind(e.target.value)} placeholder="6" /></label>
        <label>From
          <select value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="">—</option>
            {COMPASS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Gusts (mph)<input inputMode="decimal" value={gust} onChange={(e) => setGust(e.target.value)} /></label>
        <label>Temperature (°F)<input inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="72" /></label>
        <label>Rain, last 24 h (in)<input inputMode="decimal" value={rain} onChange={(e) => setRain(e.target.value)} placeholder="0" /></label>
      </div>
      <label>Note (optional)<input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="From the Mesonet station at…" /></label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** The flags on a record. */
export function WeatherFlags({ r }: { r: WeatherRecord }) {
  return (
    <span className="wl-badges">
      {r.needsWeather && <span className="wl-badge wl-b-early" title={r.weather?.lastError ?? "No weather yet"}>Needs weather</span>}
    </span>
  );
}

/** Edit or look up again one record (used on the Weather page and the work order page). */
export function RecordActions({ r, onChange, compact }: { r: WeatherRecord; onChange: (r: WeatherRecord) => void; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const run = (fn: () => Promise<WeatherRecord>) => act.run(async () => { onChange(await fn()); setEditing(false); });
  if (editing) {
    return <WeatherForm initial={r.weather} submitLabel="Save weather" busy={act.busy} error={act.error} onCancel={() => setEditing(false)}
      onSubmit={(body) => run(() => api<WeatherRecord>(`/weather/records/${r.visitId}`, { method: "PUT", body }))} />;
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className={`btn${compact ? " sm" : ""}`} onClick={() => setEditing(true)}>{r.weather?.source ? "Edit" : "Enter weather"}</button>
        <button type="button" className={`btn${compact ? " sm" : ""}`} disabled={act.busy} onClick={() => run(() => api<WeatherRecord>(`/weather/records/${r.visitId}/fetch`, { method: "POST" }))} title="Look it up from the National Weather Service for this property and time">Look up</button>
      </div>
      <ErrorBox error={act.error} />
    </div>
  );
}

/** On a completed work order (for the people who can open Chemical Tracking): its weather, if it's a chemical application. */
export function WorkOrderWeather({ visitId }: { visitId: string }) {
  const data = useApi<{ settings: WeatherSettings; record: WeatherRecord | null }>(`/weather/records/${visitId}`);
  const r = data.data?.record;
  if (!r) return null;
  const w = r.weather;
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Weather</h2>
        <WeatherFlags r={r} />
      </div>
      {w?.source ? (
        <dl className="facts">
          <dt>Wind</dt><dd>{windText(w) || "—"}</dd>
          <dt>Temperature</dt><dd>{w.tempF != null ? `${Math.round(w.tempF)}°F` : "—"}</dd>
          <dt>Rain (24 h)</dt><dd>{w.rainIn != null ? `${w.rainIn.toFixed(2)} in` : "Not reported"}</dd>
          <dt>From</dt><dd>{sourceText(w)}</dd>
          {w.note && <><dt>Note</dt><dd>{w.note}</dd></>}
          {r.gps && <><dt>GPS</dt><dd><a href={`https://www.google.com/maps/search/?api=1&query=${r.gps.lat},${r.gps.lng}`} target="_blank" rel="noopener noreferrer">{r.gps.lat.toFixed(5)}, {r.gps.lng.toFixed(5)}</a>{r.gps.accuracy ? <span className="muted"> ±{Math.round(r.gps.accuracy)} m</span> : null} at {timeOf(r.completedAt)}</dd></>}
        </dl>
      ) : (
        <p className="muted" style={{ margin: 0 }}>{w?.lastError ?? (data.data!.settings.mode === "manual" ? "Waiting for the day's weather (Chemical Tracking → Weather)." : data.data!.settings.mode === "off" ? "Weather is turned off (Chemical Tracking → Weather)." : "Looking it up…")}</p>
      )}
      <RecordActions r={r} onChange={() => data.reload()} />
    </div>
  );
}

/** The company's weather settings (admins change them). */
export function WeatherSettingsCard({ settings, canEdit, onSaved }: { settings: WeatherSettings; canEdit: boolean; onSaved: (s: WeatherSettings) => void }) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<WeatherMode>(settings.mode);
  const act = useAction();
  if (!editing) {
    return (
      <div className="card row wx-settings" style={{ justifyContent: "space-between" }}>
        <span><strong>{WEATHER_MODE_LABELS[settings.mode]}</strong><span className="muted"> · on services marked chemical in the <Link href="/price-list">price list</Link></span></span>
        {canEdit && <button type="button" className="btn sm" onClick={() => setEditing(true)}>Change</button>}
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); act.run(async () => { const s = await api<WeatherSettings>("/weather/settings", { method: "PUT", body: { mode } }); onSaved(s); setEditing(false); }); }}>
      <h2 style={{ margin: 0 }}>Weather settings</h2>
      <div className="stack" style={{ gap: 4 }}>
        {WEATHER_MODES.map((m) => <label key={m} className="check"><input type="radio" name="wx-mode" checked={mode === m} onChange={() => setMode(m)} /> {WEATHER_MODE_LABELS[m]}</label>)}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Automatic looks up wind, temperature and the last 24 hours&apos; rain from the nearest National Weather Service station for each property as it&apos;s completed. Manual uses the office&apos;s entry for the day. Either way, techs never enter weather.
      </p>
      <ErrorBox error={act.error} />
      <div className="row"><button className="btn primary" disabled={act.busy}>Save</button><button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button></div>
    </form>
  );
}

export const recordLink = (r: WeatherRecord) => <Link href={`/visits/${r.visitId}`}>{visitNumber(r.number)}</Link>;
