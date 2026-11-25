"use client";
import Link from "next/link";
import { useState } from "react";
import { type WeatherSettings } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import {
  RecordActions, WeatherFlags, WeatherForm, WeatherSettingsCard, dayOf, readingText, recordLink, sourceText, timeOf,
  type WeatherDay, type WeatherRecord,
} from "@/components/weather";

type Data = { from: string; to: string; today: string; settings: WeatherSettings; records: WeatherRecord[]; days: WeatherDay[] };
const SHOW = [["needs", "Needs weather"], ["all", "All"]] as const;
type Show = (typeof SHOW)[number][0];

/**
 * Weather on chemical applications (Field → Weather): the settings, the day's weather for manual
 * mode, and every completed chemical work order with its reading, flagged when it still needs
 * weather.
 */
export default function WeatherPage() {
  const { can } = useAuth();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const data = useApi<Data>(`/weather/records${range.from ? `?from=${range.from}&to=${range.to}` : ""}`);
  const [show, setShow] = useState<Show | null>(null);
  const d = data.data;
  const needs = d?.records.filter((r) => r.needsWeather) ?? [];
  const tab: Show = show ?? (needs.length ? "needs" : "all");
  const rows = tab === "needs" ? needs : d?.records ?? [];
  const update = (r: WeatherRecord) => d && data.setData({ ...d, records: d.records.map((x) => (x.visitId === r.visitId ? r : x)) });

  return (
    <>
      <PageHead title="Weather" sub="Wind, temperature and rain on chemical applications, for the records." />
      <ErrorBox error={data.error} />
      {d && (
        <div className="stack wx-page">
          <WeatherSettingsCard settings={d.settings} canEdit={can("admin", "customers")} onSaved={(settings) => data.setData({ ...d, settings })} />
          <DayEntry today={d.today} days={d.days} manual={d.settings.mode === "manual"} onSaved={data.reload} />
          <div className="card stack">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div className="cal-seg text-tabs" role="tablist" aria-label="Show">
                {SHOW.map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setShow(k)}>
                    {label}{k === "needs" ? ` (${needs.length})` : ` (${d.records.length})`}
                  </button>
                ))}
              </div>
              <div className="row" style={{ gap: 6, alignItems: "flex-end" }}>
                <label>From<input type="date" value={d.from} max={d.to} onChange={(e) => e.target.value && setRange({ from: e.target.value, to: d.to })} /></label>
                <label>To<input type="date" value={d.to} min={d.from} max={d.today} onChange={(e) => e.target.value && setRange({ from: d.from, to: e.target.value })} /></label>
              </div>
            </div>
            {rows.length ? (
              <div className="tablewrap">
                <table className="cl-table wx-table">
                  <thead><tr><th>Completed</th><th>Work order</th><th>Property</th><th>Weather</th><th>From</th><th /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.visitId}>
                        <td className="nowrap">{dayOf(r.date)}<div className="muted wl-sub">{timeOf(r.completedAt)}{r.finishedBy ? ` · ${r.finishedBy}` : ""}</div></td>
                        <td>{recordLink(r)}<div className="muted wl-sub">{r.services.join(", ")}</div></td>
                        <td>{r.property ? <Link href={`/properties/${r.property.id}`}>{r.property.address}</Link> : "—"}<div className="muted wl-sub"><Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link></div></td>
                        <td>
                          {r.weather?.source ? readingText(r.weather) : <span className="muted">{r.weather?.lastError ?? "Waiting"}</span>}
                          <div style={{ marginTop: 3 }}><WeatherFlags r={r} /></div>
                        </td>
                        <td className="muted wl-sub">{r.weather?.source ? sourceText(r.weather) : ""}</td>
                        <td style={{ minWidth: 220 }}><RecordActions r={r} compact onChange={update} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {tab === "needs" ? "Nothing is waiting for weather." : d.records.length ? "" : <>No chemical applications completed in these dates. Tick <strong>Chemical application</strong> on services in the <Link href="/price-list">price list</Link> to record their weather.</>}
              </Empty>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The day's weather: entered once, applied to every application that day without its own reading. */
function DayEntry({ today, days, manual, onSaved }: { today: string; days: WeatherDay[]; manual: boolean; onSaved: () => void }) {
  const [date, setDate] = useState(today);
  const [open, setOpen] = useState(manual);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  const existing = days.find((x) => x.date === date);
  if (!open) {
    return (
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <span><strong>The day&apos;s weather</strong><span className="muted"> · for days the station missed, or to enter it by hand</span></span>
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>Enter a day&apos;s weather</button>
      </div>
    );
  }
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>The day&apos;s weather</h2>
        <label className="row" style={{ gap: 6 }}>Day<input type="date" value={date} max={today} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setMsg(null); } }} /></label>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {manual ? "Enter it once a day; it goes on every chemical application completed that day, including ones completed later." : "Goes on that day's chemical applications that are still waiting for weather; automatic and office readings are kept."}
      </p>
      {msg && <div className="alert ok">{msg}</div>}
      <WeatherForm key={`${date}-${existing?.updatedAt ?? ""}`} initial={existing} submitLabel={existing ? "Update the day" : "Save for the day"} busy={act.busy} error={act.error}
        onCancel={manual ? undefined : () => setOpen(false)}
        onSubmit={(body) => act.run(async () => {
          const r = await api<{ applied: number }>(`/weather/days/${date}`, { method: "PUT", body });
          setMsg(`Saved for ${dayOf(date)}: on ${r.applied} application${r.applied === 1 ? "" : "s"}.`);
          onSaved();
        })} />
      {existing && (
        <button type="button" className="linkbtn" style={{ justifySelf: "start" }} disabled={act.busy} onClick={() => act.run(async () => {
          const r = await api<{ cleared: number }>(`/weather/days/${date}`, { method: "DELETE" });
          setMsg(`Removed the entry for ${dayOf(date)}${r.cleared ? `; ${r.cleared} application${r.cleared === 1 ? " needs" : "s need"} weather again` : ""}.`);
          onSaved();
        })}>Delete this day&apos;s entry</button>
      )}
      {days.length > 0 && (
        <div className="muted wl-sub">Entered: {days.map((x) => <button key={x.id} type="button" className="linkbtn" onClick={() => setDate(x.date)} style={{ marginRight: 8 }}>{dayOf(x.date)}</button>)}</div>
      )}
    </div>
  );
}
