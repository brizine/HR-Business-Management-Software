"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DISPATCH_PALETTE, EVENT_TYPE_COLORS, WEEKDAY_COLORS, laneKeyOf, type EventKind, type Leg } from "@crewdesk/shared";
import { api } from "@/lib/api";

/* What both dispatch boards read and do (the server side is routes/dispatch.ts). */

export type DEvent = {
  key: string; kind: EventKind; id: string; number: number | null; title: string;
  status: "open" | "on_site" | "completed" | "skipped";
  date: string; endDate: string | null; startTime: string | null; endTime: string | null; color: string;
  crewId: string | null; assigneeIds: string[];
  customer: { id: string; name: string; phone: string | null } | null;
  propertyId: string | null;
  location: { address: string; lat: number | null; lng: number | null; mapCode: string | null } | null;
  sqFt: number | null; lastServiceOn: string | null; pets: string | null; notifyBefore: string;
  budgetedHours: number | null; estMinutes: number | null; estSource: string;
  totalCents: number | null;
  invoiceable: boolean; invoice: { id: string; number: number | null; status: string } | null;
  trackedSeconds: number; runningSince: string | null; onSite: boolean;
  finishedAt: string | null; skipReason: string | null;
  frequency: string | null; seriesId: string | null;
  services: { id: string | null; name: string; quantity: number }[];
  notes: string | null; propertyNotes: string | null;
  dispatchNotes: { id: string; body: string; by: string | null; at: string }[];
  fileCount: number; tagIds: string[]; priority: string; windowStart: string | null; windowEnd: string | null;
  custom: Record<string, unknown>;
  route: { id: string; order: number } | null;
};
export type DPoint = { kind: string; label: string | null; lat: number | null; lng: number | null };
export type DRoute = {
  id: string; date: string; crewId: string | null; startTime: string; pinnedFirst: boolean; start: DPoint; end: DPoint;
  totalMeters: number; totalDriveSeconds: number; endLeg: Leg | null; measured: "road" | "estimate"; geometry: [number, number][] | null;
  stops: { key: string; order: number; leg: Leg | null }[];
};
export type DCrew = { id: string; name: string; color: string; dailyHours: number; memberIds: string[]; truck: string | null };
export type DPerson = { id: string; firstName: string; lastName: string; name: string; color: string; dailyHours: number; weeklyHours: number | null; excluded: boolean; hasAddress: boolean; status: string };
export type Place = { address: string; lat: number; lng: number };
export type Board = {
  today: string; from: string; to: string; events: DEvent[]; routes: DRoute[]; holidays: Record<string, string>; waiting: number;
  crews: DCrew[]; people: DPerson[];
  settings: { routing: "estimate" | "road"; roadUrl: string | null; startAddress: string | null; endAddress: string | null };
  start: Place | null; end: Place | null; depot: Place | null;
};
export type Preview = {
  date: string; keys: string[]; start: (DPoint & { lat: number; lng: number }) | null; end: (DPoint & { lat: number; lng: number }) | null;
  stops: { key: string; leg: Leg | null; minutes: number | null; located: boolean; steps: { text: string; meters: number }[] | null }[];
  endLeg: Leg | null; endSteps: { text: string; meters: number }[] | null; totalMeters: number; totalDriveSeconds: number; geometry: [number, number][] | null; measured: "road" | "estimate"; optimized: boolean;
};
export type Area = { id: string; name: string; color: string; points: [number, number][] };
export type Truck = { employeeId: string; name: string; color: string; lat: number; lng: number; at: string };

/** The board for a range of days. Re-read every minute and when the window is looked at again, so statuses and notes stay live. */
export function useBoard(from: string | null, to: string | null, paused = false) {
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const want = useRef("");
  const reload = useCallback(async (quiet = false) => {
    const path = from ? `/dispatch?from=${from}&to=${to ?? from}` : "/dispatch";
    want.current = path;
    if (!quiet) setLoading(true);
    try {
      const d = await api<Board>(path);
      if (want.current !== path) return;
      setData(d); setError(null);
    } catch (e) {
      if (want.current === path && !quiet) setError((e as Error).message);
    } finally {
      if (want.current === path) setLoading(false);
    }
  }, [from, to]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (paused) return;
    const again = () => { if (document.visibilityState === "visible") reload(true); };
    const timer = setInterval(again, 60_000);
    window.addEventListener("focus", again);
    return () => { clearInterval(timer); window.removeEventListener("focus", again); };
  }, [reload, paused]);
  return { data, error, loading, reload, setData };
}

/* ───────────── Dates and numbers ───────────── */

const asDate = (d: string) => new Date(`${d}T12:00:00Z`);
export const plusDays = (d: string, n: number) => new Date(asDate(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const weekdayOf = (d: string) => asDate(d).getUTCDay();
export const dateLabel = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => asDate(d).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
export const monthDay = (d: string) => dateLabel(d, { month: "short", day: "numeric" });
export const daysBetween = (a: string, b: string) => Math.round((asDate(b).getTime() - asDate(a).getTime()) / 86_400_000);
/** "Today", "Tomorrow", "4 days ago", "in 3 days". */
export function relativeDay(d: string, today: string) {
  const n = daysBetween(today, d);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return n < 0 ? `${-n} days ago` : `in ${n} days`;
}
export const startOfWeek = (d: string) => plusDays(d, -weekdayOf(d));
export const startOfMonth = (d: string) => `${d.slice(0, 8)}01`;
export const endOfMonth = (d: string) => { const [y, m] = d.split("-").map(Number); return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10); };
export const time12 = (t: string | null) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
/** 5400 seconds → "1:30 (1.5)". */
export function hoursBoth(seconds: number) {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} (${(Math.round(seconds / 360) / 10).toFixed(1)})`;
}
export const trim1 = (n: number) => (Math.round(n * 10) / 10).toString();
export const dollars = (cents: number | null) => (cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const wholeDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
/** Hours an event is planned to take: what's set on it, or the estimate. */
export const eventHours = (e: DEvent) => (e.estMinutes != null ? e.estMinutes / 60 : e.budgetedHours ?? 0);

/* ───────────── Lanes ───────────── */

export type Lane = {
  key: string; kind: "unassigned" | "crew" | "people"; name: string; color: string | null; crewId: string | null; employeeIds: string[];
  events: DEvent[]; hours: number; cents: number; capacity: number | null;
};

/** Weekdays in the range that aren't holidays (capacity counts over these). */
export function workDays(from: string, to: string, holidays: Record<string, string>) {
  let n = 0;
  for (let d = from; d <= to; d = plusDays(d, 1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays[d]) n++;
  return n;
}

/**
 * Capacity for a lane over the days shown. A crew has its own hours a day; people working together
 * can take what the one with the fewest hours can. A weekly cap applies when it's set; people marked
 * as excluded don't count, and a lane with nobody who counts has no capacity to compare against.
 */
function laneCapacity(lane: { crew?: DCrew; people: DPerson[] }, board: Pick<Board, "from" | "to" | "holidays">) {
  const single = board.from === board.to;
  const days = single ? 1 : workDays(board.from, board.to, board.holidays);
  if (lane.crew) return Math.round(lane.crew.dailyHours * days * 10) / 10;
  const counted = lane.people.filter((p) => !p.excluded);
  if (!counted.length) return null;
  const daily = Math.min(...counted.map((p) => p.dailyHours));
  const weekly = counted.map((p) => p.weeklyHours).filter((w): w is number => w != null);
  const total = daily * days;
  return Math.round((weekly.length && !single ? Math.min(total, Math.min(...weekly) * Math.max(1, Math.round(days / 5))) : total) * 10) / 10;
}

/** Unassigned first, then each crew, then each set of people working without a crew. `all` adds the crews (and people) with nothing scheduled. */
export function buildLanes(board: Board, events: DEvent[], o: { hiddenCrews?: boolean; hiddenPeople?: boolean } = {}): Lane[] {
  const by = new Map<string, DEvent[]>();
  for (const e of events) { const k = laneKeyOf(e); by.set(k, [...(by.get(k) ?? []), e]); }
  const people = new Map(board.people.map((p) => [p.id, p]));
  const sum = (es: DEvent[]) => ({ hours: Math.round(es.reduce((s, e) => s + eventHours(e), 0) * 10) / 10, cents: es.reduce((s, e) => s + (e.totalCents ?? 0), 0) });
  const order = (es: DEvent[]) => [...es].sort((a, b) => a.date.localeCompare(b.date) || (a.route && b.route ? (a.route.id === b.route.id ? a.route.order - b.route.order : a.route.id.localeCompare(b.route.id)) : a.route ? -1 : b.route ? 1 : (a.startTime ?? "99").localeCompare(b.startTime ?? "99") || a.title.localeCompare(b.title)));
  const lanes: Lane[] = [];
  const un = order(by.get("unassigned") ?? []);
  lanes.push({ key: "unassigned", kind: "unassigned", name: "Unassigned", color: null, crewId: null, employeeIds: [], events: un, ...sum(un), capacity: null });
  for (const c of board.crews) {
    const es = order(by.get(`crew:${c.id}`) ?? []);
    if (!es.length && !o.hiddenCrews) continue;
    lanes.push({ key: `crew:${c.id}`, kind: "crew", name: c.name, color: c.color, crewId: c.id, employeeIds: c.memberIds, events: es, ...sum(es), capacity: laneCapacity({ crew: c, people: [] }, board) });
  }
  const sets = [...by.keys()].filter((k) => k.startsWith("emp:"));
  const named = sets.map((k) => {
    const ids = k.slice(4).split(",");
    const ps = ids.map((id) => people.get(id)).filter((p): p is DPerson => !!p);
    return { k, ids, ps, name: ps.map((p) => p.name).join(", ") || "Someone no longer on the team" };
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const s of named) {
    const es = order(by.get(s.k) ?? []);
    lanes.push({ key: s.k, kind: "people", name: s.name, color: s.ps.length === 1 ? s.ps[0].color : null, crewId: null, employeeIds: s.ids, events: es, ...sum(es), capacity: laneCapacity({ people: s.ps }, board) });
  }
  if (o.hiddenPeople) {
    for (const p of board.people) {
      if (lanes.some((l) => l.key === `emp:${p.id}`)) continue;
      lanes.push({ key: `emp:${p.id}`, kind: "people", name: p.name, color: p.color, crewId: null, employeeIds: [p.id], events: [], hours: 0, cents: 0, capacity: laneCapacity({ people: [p] }, board) });
    }
  }
  return lanes;
}
/** How many crews and people have nothing scheduled (they stay hidden until asked for). */
export function hiddenCounts(board: Board, events: DEvent[]) {
  const keys = new Set(events.map(laneKeyOf));
  return { crews: board.crews.filter((c) => !keys.has(`crew:${c.id}`)).length, people: board.people.filter((p) => !keys.has(`emp:${p.id}`)).length };
}

/* ───────────── Colors ───────────── */

export const COLOR_MODES = ["routing", "assignment", "service", "type", "weekday"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export const COLOR_MODE_LABELS: Record<ColorMode, string> = { routing: "Routing status", assignment: "Assignment", service: "Service", type: "Event type", weekday: "Weekday" };
export const ROUTED_COLOR = "#16a34a";
export const UNROUTED_COLOR = "#78716c";
export const SELECTED_COLOR = "#2563eb";

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
export const serviceColor = (idOrName: string) => DISPATCH_PALETTE[hash(idOrName) % DISPATCH_PALETTE.length];

/** The color (or two, for a pair of people) and legend label of an event under a coloring. */
export function eventColor(e: DEvent, mode: ColorMode, board: Pick<Board, "crews" | "people">): { colors: string[]; label: string } {
  if (mode === "routing") return e.route ? { colors: [ROUTED_COLOR], label: "Routed" } : { colors: [UNROUTED_COLOR], label: "Unrouted" };
  if (mode === "type") return { colors: [EVENT_TYPE_COLORS[e.kind]], label: e.kind === "visit" ? "Work orders" : "To-dos" };
  if (mode === "weekday") return { colors: [WEEKDAY_COLORS[weekdayOf(e.date)]], label: dateLabel(e.date, { weekday: "long" }) };
  if (mode === "service") {
    const s = e.services[0];
    return s ? { colors: [serviceColor(s.id ?? s.name)], label: s.name } : { colors: [UNROUTED_COLOR], label: "No service" };
  }
  if (e.crewId) { const c = board.crews.find((x) => x.id === e.crewId); return { colors: [c?.color ?? UNROUTED_COLOR], label: c?.name ?? "A crew" }; }
  const ps = e.assigneeIds.map((id) => board.people.find((p) => p.id === id)).filter((p): p is DPerson => !!p);
  if (!ps.length) return { colors: [UNROUTED_COLOR], label: "Unassigned" };
  return { colors: ps.slice(0, 2).map((p) => p.color), label: ps.map((p) => p.name).join(", ") };
}

/** Who an event is assigned to, in words. */
export function assignmentText(e: Pick<DEvent, "crewId" | "assigneeIds">, board: Pick<Board, "crews" | "people">) {
  if (e.crewId) return board.crews.find((c) => c.id === e.crewId)?.name ?? "A crew";
  const names = e.assigneeIds.map((id) => board.people.find((p) => p.id === id)?.name).filter(Boolean);
  return names.join(", ");
}

/* ───────────── Filters ───────────── */

export type Filters = Record<string, string[]>;
export const FILTER_DEFS: { key: string; label: string }[] = [
  { key: "status", label: "Status" }, { key: "recurring", label: "Recurring" }, { key: "crew", label: "Crew" }, { key: "employee", label: "Employee" },
  { key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" }, { key: "tracked", label: "Tracked time" }, { key: "visitNotes", label: "Visit notes" },
  { key: "type", label: "Type" }, { key: "onSite", label: "On Site" }, { key: "service", label: "Item/Service" }, { key: "tag", label: "Tag" },
  { key: "routed", label: "Routed" }, { key: "dispatchNotes", label: "Dispatch notes" }, { key: "mapCode", label: "Map Code" },
];

/** The values an event has for a filter (it matches when any picked value is among them). */
export function filterValues(e: DEvent, key: string): string[] {
  switch (key) {
    case "status": return [e.status === "on_site" ? "open" : e.status];
    case "recurring": return [e.seriesId ? "recurring" : "once"];
    case "crew": return [e.crewId ?? "none"];
    case "employee": return e.assigneeIds.length ? e.assigneeIds : ["none"];
    case "customer": return [e.customer?.id ?? "none"];
    case "invoice": return [e.invoice ? "invoiced" : "not"];
    case "tracked": return [e.trackedSeconds > 0 ? "has" : "none"];
    case "visitNotes": return [e.notes?.trim() ? "has" : "none"];
    case "type": return [e.kind];
    case "onSite": return [e.onSite ? "yes" : "no"];
    case "service": return e.services.length ? e.services.map((s) => s.id ?? `name:${s.name}`) : ["none"];
    case "tag": return e.tagIds.length ? e.tagIds : ["none"];
    case "routed": return [e.route ? "routed" : "unrouted"];
    case "dispatchNotes": return [e.dispatchNotes.length ? "has" : "none"];
    case "mapCode": return [e.location?.mapCode ?? "none"];
    default: return [];
  }
}
const FIXED_OPTIONS: Record<string, [string, string][]> = {
  status: [["open", "Open"], ["skipped", "Skipped"], ["completed", "Complete"]],
  recurring: [["recurring", "Recurring"], ["once", "One-time"]],
  invoice: [["invoiced", "Invoiced"], ["not", "Not invoiced"]],
  tracked: [["has", "Has time tracked"], ["none", "No time tracked"]],
  visitNotes: [["has", "Has visit notes"], ["none", "Does not have visit notes"]],
  type: [["visit", "Work order"], ["todo", "To-do"]],
  onSite: [["yes", "Is On Site"], ["no", "Not On Site"]],
  routed: [["routed", "Routed"], ["unrouted", "Unrouted"]],
  dispatchNotes: [["has", "Has dispatch notes"], ["none", "Does not have dispatch notes"]],
};
/** The choices for a filter, each with how many events on the board have it. */
export function filterOptions(key: string, events: DEvent[], board: Pick<Board, "crews" | "people">, tags: { id: string; name: string }[]): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) for (const v of new Set(filterValues(e, key))) counts.set(v, (counts.get(v) ?? 0) + 1);
  const n = (v: string) => counts.get(v) ?? 0;
  if (FIXED_OPTIONS[key]) return FIXED_OPTIONS[key].map(([value, label]) => ({ value, label, count: n(value) }));
  if (key === "crew") return [...board.crews.map((c) => ({ value: c.id, label: c.name, count: n(c.id) })), { value: "none", label: "No crew", count: n("none") }];
  if (key === "employee") return [...board.people.map((p) => ({ value: p.id, label: p.name, count: n(p.id) })), { value: "none", label: "Nobody", count: n("none") }];
  if (key === "tag") return [...tags.map((t) => ({ value: t.id, label: t.name, count: n(t.id) })), { value: "none", label: "No tags", count: n("none") }];
  const names = new Map<string, string>();
  for (const e of events) {
    if (key === "customer") names.set(e.customer?.id ?? "none", e.customer?.name ?? "No customer");
    if (key === "service") for (const s of e.services) names.set(s.id ?? `name:${s.name}`, s.name);
    if (key === "mapCode") names.set(e.location?.mapCode ?? "none", e.location?.mapCode ? `MC ${e.location.mapCode}` : "No Map Code");
  }
  if (key === "service" && counts.has("none")) names.set("none", "No items or services");
  return [...names].map(([value, label]) => ({ value, label, count: n(value) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
export function applyFilters(events: DEvent[], filters: Filters, search: string) {
  const active = Object.entries(filters).filter(([, v]) => v.length);
  const q = search.trim().toLowerCase();
  return events.filter((e) => {
    for (const [key, picked] of active) { const have = filterValues(e, key); if (!picked.some((p) => have.includes(p))) return false; }
    if (!q) return true;
    return [e.title, e.customer?.name, e.location?.address, e.number ? `wo-${e.number}` : "", ...e.services.map((s) => s.name)].some((t) => t?.toLowerCase().includes(q));
  });
}

/* ───────────── Moves ───────────── */

const post = <T,>(path: string, body: unknown) => api<T>(`/dispatch${path}`, { method: "POST", body });
export const dispatchApi = {
  assign: (keys: string[], to: { crewId?: string | null; employeeIds?: string[] }) => post<{ assigned: number; unrouted: number; crewId: string | null; people: number }>("/assign", { keys, ...to }),
  reschedule: (keys: string[], date: string) => post<{ rescheduled: number; reopened: number; unrouted: number }>("/reschedule", { keys, date }),
  toWaitlist: (keys: string[], dueBy: "keep" | string | null) => post<{ moved: number }>("/waitlist", { keys, dueBy }),
  duplicate: (keys: string[]) => post<{ duplicated: number; keys: string[] }>("/duplicate", { keys }),
  remove: (keys: string[]) => post<{ deleted: number; kept: number }>("/delete", { keys }),
  unroute: (keys: string[]) => post<{ unrouted: number }>("/unroute", { keys }),
  preview: (body: Record<string, unknown>) => post<Preview>("/routes/preview", body),
  saveRoute: (body: Record<string, unknown>) => post<{ id: string; stops: number; future: { days: number; stops: number } | null }>("/routes", body),
  future: (body: Record<string, unknown>) => post<{ days: { date: string; stops: number; different: number }[]; repeating: number }>("/routes/future", body),
  lane: (date: string, crewId: string | null, keys: string[]) => post<{ stops: number; totalDriveSeconds?: number }>("/lane", { date, crewId, keys }),
  rain: (body: Record<string, unknown>) => post<{ moved: number; to: string | null; texted: number; notTexted: number; toCall: string[] }>("/rain", body),
  note: (key: string, body: string) => post<{ key: string; dispatchNotes: DEvent["dispatchNotes"] }>("/notes", { key, body }),
  /** Open, Complete or Skipped, one event at a time, through each record's own rules. */
  async setStatus(e: DEvent, status: "open" | "completed" | "skipped", reason?: string) {
    if (e.kind === "todo") {
      if (status === "skipped") throw new Error("To-dos can't be skipped; mark them done or delete them.");
      return api(`/todos/${e.id}/done`, { method: "POST", body: { done: status === "completed" } });
    }
    if (status === "completed") return api(`/visits/${e.id}/complete`, { method: "POST", body: {} });
    if (status === "skipped") return api(`/visits/${e.id}/skip`, { method: "POST", body: { reason } });
    return api(`/visits/${e.id}/reopen`, { method: "POST", body: {} });
  },
};

/** The page an event opens on (its own page, where everything about it is edited). */
export const eventHref = (e: Pick<DEvent, "kind" | "id">, edit = false) => (e.kind === "visit" ? `/visits/${e.id}${edit ? "?edit=1" : ""}` : `/todos/${e.id}`);
