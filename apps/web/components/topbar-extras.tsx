"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Forecast, ForecastIcon, ForecastPeriod, WeatherLink } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/icons";

/** Closes a pop-up on a click elsewhere or Esc. */
function useAway(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close, ref]);
}

/* ───────────────────────── Weather ───────────────────────── */

type ForecastBox = {
  forecast: Forecast | null; stale: boolean; links: WeatherLink[]; problem: string | null; canEdit: boolean;
  /** How the place was found: the business address itself, or the next best thing when that can't be put on a map. */
  spot?: "address" | "town" | "company" | "properties" | null;
};
/** Said under the forecast when it isn't for the business address itself. */
const SPOT_NOTE: Record<string, string> = {
  company: "This is the forecast for your real company's location: the test company's own address isn't on the map.",
  properties: "This is the forecast for the middle of the properties you work at: your business address couldn't be placed on a map.",
  town: "This is the forecast for your town: the street address couldn't be placed on a map.",
};
const PICTURE: Record<ForecastIcon, string> = {
  sun: "sun", moon: "moon", partly: "cloudSun", "partly-night": "cloudMoon", cloud: "cloud", rain: "cloudRain", storm: "cloudStorm", snow: "cloudSnow", fog: "cloudFog", wind: "wind",
};
const QUARTER = 15 * 60_000;
/** "9 am", read from the forecast's own clock (the business's time, wherever the person looking is). */
const hourLabel = (iso: string) => { const h = Number(iso.slice(11, 13)); return Number.isNaN(h) ? "" : `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };
const untilLabel = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return ` until ${d.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
};

type DayRow = { name: string; icon: ForecastIcon; hi: number | null; lo: number | null; short: string; wind: string; rain: number | null; detail: string };
/** The forecast a day to a line: each day with the night after it. */
export function forecastDays(periods: ForecastPeriod[]): DayRow[] {
  const rows: DayRow[] = [];
  const most = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i], n = periods[i + 1];
    const wind = `${p.windDir} ${p.wind}`.trim();
    if (p.day && n && !n.day) {
      rows.push({ name: p.name, icon: p.icon, hi: p.tempF, lo: n.tempF, short: p.short, wind, rain: most(p.rainPct, n.rainPct), detail: `${p.detail} ${n.name}: ${n.detail}`.trim() });
      i++;
    } else rows.push({ name: p.name, icon: p.icon, hi: p.day ? p.tempF : null, lo: p.day ? null : p.tempF, short: p.short, wind, rain: p.rainPct, detail: p.detail });
  }
  return rows.slice(0, 8);
}

/**
 * The weather icon, left of the search box: the hour's weather at the business address, and a box
 * with the National Weather Service's forecast, its warnings, links to its pages, and the company's
 * own links to other weather sites (set in Settings → Company Info).
 */
export function WeatherButton() {
  const [box, setBox] = useState<ForecastBox | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const loaded = useRef(0);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useAway(open, close, ref);
  const load = useCallback(() => api<ForecastBox>("/company/forecast").then((b) => { setBox(b); setFailed(false); loaded.current = Date.now(); }, () => setFailed(true)), []);
  useEffect(() => {
    void load();
    // Kept fresh while the page is being looked at, and caught up when it's come back to.
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, QUARTER);
    const back = () => { if (Date.now() - loaded.current > QUARTER) void load(); };
    window.addEventListener("focus", back);
    window.addEventListener("crewdesk:weather-links", load);
    return () => { clearInterval(t); window.removeEventListener("focus", back); window.removeEventListener("crewdesk:weather-links", load); };
  }, [load]);
  const f = box?.forecast ?? null;
  const now = f?.hours[0] ?? null;
  const alerts = f?.alerts ?? [];
  const label = now ? `Weather: ${now.short}${now.tempF != null ? `, ${now.tempF} degrees` : ""}${alerts.length ? `. ${alerts.length} weather ${alerts.length === 1 ? "alert" : "alerts"}` : ""}` : "Weather forecast";
  return (
    <div className="topbar-pop topbar-weather" ref={ref}>
      <button type="button" className={`topbar-icon topbar-weather-btn${now?.tempF != null ? " with-temp" : ""}`} aria-expanded={open} aria-label={label} title={now ? `${now.short}${now.tempF != null ? `, ${now.tempF}°` : ""}: click for the forecast` : "Weather forecast"}
        onClick={() => { if (!open && Date.now() - loaded.current > 5 * 60_000) void load(); setOpen(!open); }}>
        <Icon name={now ? PICTURE[now.icon] : "cloudSun"} />
        {now?.tempF != null && <span className="topbar-weather-temp">{now.tempF}°</span>}
        {alerts.length > 0 && <span className="topbar-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="topbar-popover wx-box" role="dialog" aria-label="Weather forecast">
          {!box ? <p className="muted" style={{ margin: 0 }}>{failed ? "Couldn't load the forecast. Check your connection and try again." : "Loading the forecast…"}</p> : <Forecasted box={box} onClose={close} />}
        </div>
      )}
    </div>
  );
}

function Forecasted({ box, onClose }: { box: ForecastBox; onClose: () => void }) {
  const f = box.forecast;
  const out = { target: "_blank", rel: "noopener noreferrer" } as const;
  const now = f?.hours[0];
  return (
    <>
      <div className="wx-head">
        <strong>{f?.place || "Weather"}</strong>
        {f && <a className="muted" href={f.pages.forecast} {...out}>National Weather Service <Icon name="external" size={12} /></a>}
      </div>
      {!f && <p className="wx-problem">{box.problem}</p>}
      {f && (
        <>
          {f.alerts.map((a, i) => (
            <a key={i} className={`wx-alert${a.severity === "Extreme" || a.severity === "Severe" ? " severe" : ""}`} href={a.url ?? f.pages.forecast} title={a.headline} {...out}>
              <Icon name="alert" size={15} /><span><strong>{a.event}</strong>{untilLabel(a.ends)}</span>
            </a>
          ))}
          {now && (
            <div className="wx-now">
              <Icon name={PICTURE[now.icon]} size={34} />
              <div className="wx-now-temp">{now.tempF != null ? `${now.tempF}°` : "—"}</div>
              <div className="wx-now-words">
                <strong>{now.short || "Now"}</strong>
                <span>Wind {now.windMph != null ? `${now.windDir} ${now.windMph} mph`.trim() : "—"}{now.rainPct != null ? ` · Rain ${now.rainPct}%` : ""}{now.humidity != null ? ` · Humidity ${Math.round(now.humidity)}%` : ""}</span>
              </div>
            </div>
          )}
          {f.hours.length > 1 && (
            <div className="wx-hours" role="table" aria-label="The hours ahead">
              {f.hours.slice(0, 12).map((h) => (
                <div key={h.at} role="row" title={`${hourLabel(h.at)}: ${h.short}`}>
                  <span className="wx-hour" role="cell">{hourLabel(h.at)}</span>
                  <Icon name={PICTURE[h.icon]} size={18} />
                  <strong role="cell">{h.tempF != null ? `${h.tempF}°` : "—"}</strong>
                  <span className="wx-wind" role="cell" aria-label={h.windMph != null ? `wind ${h.windDir} ${h.windMph} miles an hour` : undefined}>{h.windMph != null ? <>{h.windMph}<small> {h.windDir}</small></> : "—"}</span>
                  <span className={`wx-rain${(h.rainPct ?? 0) >= 30 ? " wet" : ""}`} role="cell" aria-label={h.rainPct != null ? `${h.rainPct} percent chance of rain` : undefined}>{h.rainPct != null ? `${h.rainPct}%` : ""}</span>
                </div>
              ))}
            </div>
          )}
          {f.hours.length > 1 && <div className="wx-key muted">Each hour: temperature, wind (mph and where it blows from), chance of rain</div>}
          <div className="wx-days">
            {forecastDays(f.periods).map((d) => (
              <details key={d.name}>
                <summary>
                  <span className="wx-day">{d.name}</span>
                  <Icon name={PICTURE[d.icon]} size={18} />
                  <span className="wx-temps">{d.hi != null && <strong>{d.hi}°</strong>}{d.hi != null && d.lo != null && " / "}{d.lo != null && <span className="muted">{d.lo}°</span>}</span>
                  <span className="wx-short">{d.short}</span>
                  <span className={`wx-rain${(d.rain ?? 0) >= 30 ? " wet" : ""}`}>{d.rain ? `${d.rain}%` : ""}</span>
                </summary>
                <p>{d.detail}{d.wind && !d.detail ? `Wind ${d.wind}.` : ""}</p>
              </details>
            ))}
          </div>
          <div className="wx-foot muted">
            {box.stale ? "The Weather Service couldn't be reached just now; this is its last forecast" : "Forecast from the National Weather Service"}
            {f.updatedAt ? `, written ${new Date(f.updatedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}. Click a day for its details.
            {box.spot && SPOT_NOTE[box.spot] ? <> {SPOT_NOTE[box.spot]}{box.canEdit && box.spot !== "company" ? <> Check it in <Link href="/settings/company-info" onClick={onClose}>Settings → Company Info</Link>.</> : null}</> : null}
          </div>
        </>
      )}
      <div className="wx-links">
        {f && (
          <div>
            <span className="todo-label">National Weather Service</span>
            <a href={f.pages.forecast} {...out}>7-day forecast</a>
            <a href={f.pages.hourly} {...out}>Hourly graph</a>
            <a href={f.pages.radar} {...out}>Radar</a>
          </div>
        )}
        {(box.links.length > 0 || box.canEdit) && (
          <div>
            <span className="todo-label">More weather</span>
            {box.links.map((l, i) => <a key={i} href={l.url} title={l.url} {...out}>{l.label}</a>)}
            {box.canEdit && <Link className="wx-edit" href="/settings/company-info#weather-links" onClick={onClose}>{box.links.length ? "Edit links" : "Add your own weather sites"}</Link>}
          </div>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── Phone ───────────────────────── */

type Incoming = {
  id: string; kind: "call" | "voicemail"; result: "answered" | "missed" | "hangup"; seconds: number; phone: string; phoneText: string; callerName: string | null; at: string;
  transcript: string | null; who: "customer" | "employee" | "unknown"; name: string | null; customerId: string | null; address: string | null; status: string | null;
};
const lasted = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`);
const read = <T,>(store: Storage, key: string, fallback: T): T => { try { const v = store.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const write = (store: Storage, key: string, value: unknown) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* private window */ } };

/**
 * The phone icon, right of the search box. Clicking it opens the computer's calling app (the
 * Talkroute desktop app, once it's set as the default for calls). When a call comes in, a caller
 * box pops up under it: who it was, their address, how the call went, and ways to follow up. The
 * phone service reports a call as it ends, so the box shows seconds after the caller hangs up (or
 * isn't answered); while it's ringing, the name shows in Talkroute's own app.
 */
export function PhoneButton() {
  const { me } = useAuth();
  const allowed = !!me?.access?.texting;
  const [calls, setCalls] = useState<Incoming[]>([]);
  const restored = useRef(false);
  // Boxes still open come back after the page is reloaded (for half an hour; after that they're old news).
  useEffect(() => {
    if (!allowed) return;
    if (!restored.current) {
      restored.current = true;
      const closed = read<string[]>(localStorage, "calls-closed", []);
      const open = read<Incoming[]>(sessionStorage, "calls-open", []).filter((c) => c?.id && !closed.includes(c.id) && Date.now() - Date.parse(c.at) < 30 * 60_000);
      if (open.length) setCalls(open);
      return;
    }
    write(sessionStorage, "calls-open", calls);
  }, [allowed, calls]);
  useEffect(() => {
    if (!allowed) return;
    let stopped = false, busy = false;
    let after: string | null = read<string | null>(sessionStorage, "calls-after", null);
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const r = await api<{ now: string; calls: Incoming[] }>(`/texting/calls/recent${after ? `?after=${encodeURIComponent(after)}` : ""}`);
        if (stopped) return;
        after = r.now;
        write(sessionStorage, "calls-after", after);
        const closed = read<string[]>(localStorage, "calls-closed", []);
        const fresh = r.calls.filter((c) => !closed.includes(c.id));
        // Newest on top; four at most, so a busy morning doesn't cover the page.
        if (fresh.length) setCalls((cur) => [...fresh.filter((c) => !cur.some((x) => x.id === c.id)).reverse(), ...cur].slice(0, 4));
      } catch { /* offline, or signed out: the next round tries again */ } finally { busy = false; }
    };
    void tick();
    const t = setInterval(tick, 8000);
    document.addEventListener("visibilitychange", tick);
    // Closed in another window: closed here too.
    const other = (e: StorageEvent) => { if (e.key === "calls-closed") { const closed = read<string[]>(localStorage, "calls-closed", []); setCalls((cur) => cur.filter((c) => !closed.includes(c.id))); } };
    window.addEventListener("storage", other);
    return () => { stopped = true; clearInterval(t); document.removeEventListener("visibilitychange", tick); window.removeEventListener("storage", other); };
  }, [allowed]);
  const dismiss = (id: string) => {
    setCalls((cur) => cur.filter((c) => c.id !== id));
    write(localStorage, "calls-closed", [id, ...read<string[]>(localStorage, "calls-closed", [])].slice(0, 30));
  };
  if (!allowed) return null;
  return (
    <div className="topbar-pop topbar-phone">
      <a className="topbar-icon" href="tel:" aria-label="Open the phone app (Talkroute)" title="Open Talkroute, your computer's calling app"><Icon name="phone" /></a>
      {calls.length > 0 && (
        <div className="call-stack" role="region" aria-label="Calls that just came in" aria-live="polite">
          {calls.map((c) => <CallerBox key={c.id} call={c} onClose={() => dismiss(c.id)} />)}
        </div>
      )}
    </div>
  );
}

function CallerBox({ call: c, onClose }: { call: Incoming; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const missed = c.kind === "voicemail" || c.result !== "answered";
  const how = c.kind === "voicemail" ? `Left a voicemail${c.seconds ? ` · ${lasted(c.seconds)}` : ""}` : c.result === "answered" ? `Answered · ${lasted(c.seconds)}` : c.result === "hangup" ? "Hung up before anyone answered" : "Missed call";
  const text = async () => {
    setBusy(true);
    try { const t = await api<{ id: string }>("/texting/threads/open", { body: { phone: c.phone } }); onClose(); router.push(`/texts?thread=${t.id}`); }
    catch { router.push("/texts"); }
    finally { setBusy(false); }
  };
  return (
    <div className={`call-box${missed ? " missed" : ""}`} role="group" aria-label={`Call from ${c.name ?? c.phoneText}`}>
      <div className="call-top">
        <Icon name="phoneIn" size={18} />
        <div className="call-who">
          <strong>{c.name ?? (c.callerName ? c.callerName : "Unknown caller")}</strong>
          <span>{c.phoneText}{c.who === "employee" ? " · on your team" : c.who === "unknown" ? " · not in your customers" : c.status && c.status !== "active" ? ` · ${c.status} customer` : ""}</span>
        </div>
        <button type="button" className="call-x" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
      {c.address && <div className="call-line">{c.address}</div>}
      {c.name && c.callerName && <div className="call-line muted">Caller ID: {c.callerName}</div>}
      <div className={`call-line call-how${missed ? " bad" : ""}`}>{how} · {new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
      {c.transcript && <div className="call-words">“{c.transcript}”</div>}
      <div className="call-actions">
        {c.customerId && <Link className="btn sm primary" href={`/customers/${c.customerId}`} onClick={onClose}>Open customer</Link>}
        <a className="btn sm" href={`tel:${c.phone}`}>Call back</a>
        <button type="button" className="btn sm" disabled={busy} onClick={text}>Text</button>
      </div>
    </div>
  );
}

/* ───────────────────────── Email ───────────────────────── */

/** The envelope, right of the search box: the emails Crewdesk has sent, with the email templates a tab away. */
export function EmailButton() {
  return <Link href="/templates?tab=history" className="topbar-icon topbar-email" aria-label="Email" title="Email: what's been sent, and your templates"><Icon name="mail" /></Link>;
}
