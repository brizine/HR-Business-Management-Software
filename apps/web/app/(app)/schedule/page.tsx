"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { availabilityConflicts, describeRule, isInactive } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { useMenuData } from "@/lib/menus";
import { AvailabilityEditor } from "@/components/availability-editor";
import { WeekPicker } from "@/components/week-picker";

const DAY = 86_400_000;

/** Local midnight on Monday, `offset` weeks from this one. */
function weekStart(offset: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hours = (s: any) => (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 3_600_000;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The same calendar day `n` weeks later (local dates, so daylight saving doesn't move it). */
const plusWeeks = (date: string, n: number) => { const [y, m, d] = date.split("-").map(Number); return ymd(new Date(y, m - 1, d + 7 * n)); };
const WEEK_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 26];
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Distinct non-empty values, sorted, for a filter drop-down. */
const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))].sort((a, b) => a.localeCompare(b));

const NO_FILTERS = { q: "", title: "", dept: "", position: "", location: "", asset: "", status: "", show: "" };
type Filters = typeof NO_FILTERS;

type Draft = { id?: string; employeeId: string; date: string; start: string; end: string; position?: string; location?: string; assetId?: string; notes?: string; status?: string };

function ShiftEditor({ draft, weekDays, employees, assets, templates, onClose, onSaved, onTemplatesChanged }: {
  draft: Draft; weekDays: Date[]; employees: any[]; assets: any[]; templates: any[];
  onClose: () => void; onSaved: (warnings: string[]) => void; onTemplatesChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const formRef = useRef<HTMLFormElement>(null);
  // New shifts can go on several days of the week shown at once.
  const [picked, setPicked] = useState<string[]>([draft.date]);
  const toggle = (d: string) => setPicked((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));
  // How many weeks to repeat a new shift for (1 = this week only), and how many weeks to copy an existing one to.
  const [weeks, setWeeks] = useState(1);
  const [copyWeeks, setCopyWeeks] = useState(4);

  /** Fills the form from a saved template, keeping the chosen person and date. */
  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    const form = formRef.current;
    if (!t || !form) return;
    const field = (name: string, value: string) => ((form.elements.namedItem(name) as HTMLInputElement).value = value);
    field("start", t.startTime);
    field("end", t.endTime);
    field("position", t.position ?? "");
    field("location", t.location ?? "");
    field("assetId", t.assetId ?? "");
    field("notes", t.notes ?? "");
  };

  const saveAsTemplate = () => {
    const f = new FormData(formRef.current!);
    const name = prompt("Template name", (f.get("position") as string) || "");
    if (!name) return;
    const str = (k: string) => (f.get(k) as string) || undefined;
    run(async () => {
      await api("/shifts/templates", { body: {
        name, startTime: f.get("start"), endTime: f.get("end"),
        position: str("position"), location: str("location"), assetId: str("assetId") ?? null, notes: str("notes"),
      } });
      onTemplatesChanged();
    });
  };
  const save = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const str = (k: string) => (f.get(k) as string) || undefined;
    const shiftOn = (date: string) => {
      const startsAt = new Date(`${date}T${f.get("start")}`);
      let endsAt = new Date(`${date}T${f.get("end")}`);
      // An end time at or before the start means the shift runs past midnight.
      if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + DAY);
      return {
        employeeId: str("employeeId") ?? null,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        position: str("position"),
        location: str("location"),
        assetId: str("assetId") ?? null,
        notes: str("notes"),
      };
    };
    /** Adds shifts on these dates; when repeating, days the person is already booked are skipped and listed. */
    const addOn = async (dates: string[], skipOverlaps: boolean) => {
      const res = await api("/shifts/bulk", { body: { shifts: dates.sort().map(shiftOn), skipOverlaps } });
      const skipped: string[] = res.skipped ?? [];
      return [...res.warnings, ...(skipped.length ? [`skipped ${skipped.join(", ")} (already has a shift then)`] : [])];
    };
    run(async () => {
      if (draft.id) {
        const res = await api(`/shifts/${draft.id}`, { method: "PATCH", body: shiftOn(f.get("date") as string) });
        return onSaved(res.warnings);
      }
      if (!picked.length) throw new Error("Pick at least one day");
      const dates = Array.from({ length: weeks }, (_, w) => picked.map((d) => plusWeeks(d, w))).flat();
      onSaved(await addOn(dates, weeks > 1));
    });
  };

  /** Copies the shift being edited (as it is in the form) to the same day in each of the next weeks. */
  const copyToWeeks = () => {
    const form = formRef.current!;
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const date = f.get("date") as string;
    const str = (k: string) => (f.get(k) as string) || undefined;
    run(async () => {
      const shiftsToAdd = Array.from({ length: copyWeeks }, (_, i) => {
        const day = plusWeeks(date, i + 1);
        const startsAt = new Date(`${day}T${f.get("start")}`);
        let endsAt = new Date(`${day}T${f.get("end")}`);
        if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + DAY);
        return { employeeId: str("employeeId") ?? null, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), position: str("position"), location: str("location"), assetId: str("assetId") ?? null, notes: str("notes") };
      });
      const res = await api("/shifts/bulk", { body: { shifts: shiftsToAdd, skipOverlaps: true } });
      const skipped: string[] = res.skipped ?? [];
      onSaved([`copied to ${res.shifts.length} more week${res.shifts.length === 1 ? "" : "s"} as drafts`, ...res.warnings, ...(skipped.length ? [`skipped ${skipped.join(", ")} (already has a shift then)`] : [])]);
    });
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{draft.id ? "Edit shift" : "New shift"} {draft.status && <Badge value={draft.status} />}</h2>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <form ref={formRef} className="stack" onSubmit={(e) => { e.preventDefault(); save(e.currentTarget); }}>
        {templates.length > 0 && (
          <label style={{ maxWidth: 320 }}>Start from a template
            <select defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Choose…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.startTime}–{t.endTime})</option>)}
            </select>
          </label>
        )}
        {!draft.id && (
          <fieldset className="daypick">
            <legend>Days</legend>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {weekDays.map((d) => {
                const v = ymd(d);
                return (
                  <label key={v} className={`daychip ${picked.includes(v) ? "on" : ""}`}>
                    <input type="checkbox" checked={picked.includes(v)} onChange={() => toggle(v)} />
                    {d.toLocaleDateString([], { weekday: "short" })} {d.getMonth() + 1}/{d.getDate()}
                  </label>
                );
              })}
              <button type="button" className="btn sm" onClick={() => setPicked(weekDays.slice(0, 5).map(ymd))}>Mon–Fri</button>
              <button type="button" className="btn sm" onClick={() => setPicked(weekDays.map(ymd))}>Every day</button>
              <button type="button" className="btn sm" onClick={() => setPicked([])}>Clear</button>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Repeat</span>
              <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} style={{ width: "auto" }} aria-label="Repeat for how many weeks">
                {WEEK_CHOICES.map((n) => <option key={n} value={n}>{n === 1 ? "This week only" : `For ${n} weeks (this week and the next ${n - 1})`}</option>)}
              </select>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              The same hours go on each day you tick{weeks > 1 ? `, every week for ${weeks} weeks. Days someone is already booked are skipped` : ""}. To start in another week, change the week at the top of the page.
            </div>
          </fieldset>
        )}
        <div className="formgrid">
          <label>Who
            <select name="employeeId" defaultValue={draft.employeeId}>
              <option value="">Open shift (anyone can claim)</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
          {draft.id && <label>Date<input name="date" type="date" defaultValue={draft.date} required /></label>}
          <label>Start<input name="start" type="time" defaultValue={draft.start} required /></label>
          <label>End<input name="end" type="time" defaultValue={draft.end} required /></label>
          <label>Position<input name="position" defaultValue={draft.position} placeholder="Driver, crew lead…" /></label>
          <label>Location / job site<input name="location" defaultValue={draft.location} /></label>
          <label>Vehicle / equipment
            <select name="assetId" defaultValue={draft.assetId ?? ""}>
              <option value="">None</option>
              {assets.filter((a) => a.status !== "retired").map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== "active" ? ` (${a.status.replace(/_/g, " ")})` : ""}</option>)}
            </select>
          </label>
          <label>Notes<input name="notes" defaultValue={draft.notes} /></label>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy || (!draft.id && !picked.length)}>{draft.id || picked.length * weeks <= 1 ? "Save" : `Save ${picked.length * weeks} shifts`}</button>
          {draft.id && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => confirm("Delete this shift?") && run(async () => { await api(`/shifts/${draft.id}`, { method: "DELETE" }); onSaved([]); })}>
              Delete
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={saveAsTemplate}>Save as template</button>
          {draft.status === "published" && <span className="muted">The employee will be notified of changes.</span>}
        </div>
        {draft.id && (
          <div className="row" style={{ gap: 8, alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <span>Copy this shift to the same day for the next</span>
            <select value={copyWeeks} onChange={(e) => setCopyWeeks(Number(e.target.value))} style={{ width: "auto" }} aria-label="Number of weeks to copy to">
              {WEEK_CHOICES.map((n) => <option key={n} value={n}>{n} week{n === 1 ? "" : "s"}</option>)}
            </select>
            <button type="button" className="btn" disabled={busy} onClick={copyToWeeks}>Copy</button>
            <span className="muted" style={{ fontSize: 12 }}>Copies are drafts until you publish each week. Weeks the person is already booked are skipped.</span>
          </div>
        )}
      </form>
    </div>
  );
}

export default function Schedule() {
  const { me, can } = useAuth();
  const manager = can("manager", "schedule");
  const [offset, setOffset] = useState(0);
  const from = weekStart(offset);
  const to = weekStart(offset + 1);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const list = useApi<any[]>(`/shifts?from=${from.toISOString()}&to=${to.toISOString()}`);
  const employees = useApi<any[]>("/employees");
  const assets = useApi<any[]>("/assets");
  const drops = useApi<any[]>(manager ? "/shifts/drop-requests" : null);
  const templates = useApi<any[]>(manager ? "/shifts/templates" : null);
  const unavailable = useApi<any[]>("/availability");
  // Paid holidays this week, shown in the day headers.
  const weekHolidays = useApi<{ upcoming: { holidayId: string; name: string; observed: string; date: string }[] }>(`/holidays?from=${ymd(from)}&to=${ymd(addDays(from, 6))}`);
  const [showAvailability, setShowAvailability] = useState(false);
  // Availability is only tracked for part-time employees.
  const partTime = me?.user.employmentType === "part_time";
  const [showTemplates, setShowTemplates] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const { menus } = useMenuData();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const setFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = Object.values(filters).some(Boolean);

  const staff = useMemo(() => (employees.data ?? []).filter((e) => !isInactive(e.status)), [employees.data]);
  const allShifts = (list.data ?? []).map((r) => ({ ...r.shift, assetName: r.assetName }));
  const nameOf = (id: string | null) => { const e = id && staff.find((x) => x.id === id); return e ? `${e.firstName} ${e.lastName}` : ""; };
  const q = filters.q.trim().toLowerCase();
  // Filters on the shift itself (position, site, vehicle, draft/published) narrow the shifts shown.
  const shiftFiltered = !!(filters.position || filters.location || filters.asset || filters.status);
  const shifts = allShifts.filter((s) =>
    (!filters.position || s.position === filters.position) &&
    (!filters.location || s.location === filters.location) &&
    (!filters.asset || s.assetId === filters.asset) &&
    (!filters.status || s.status === filters.status) &&
    // Search matches the person's name, or anything written on the shift.
    (!q || `${nameOf(s.employeeId)} ${s.position ?? ""} ${s.location ?? ""} ${s.assetName ?? ""} ${s.notes ?? ""}`.toLowerCase().includes(q)));
  const drafts = allShifts.filter((s) => s.status === "draft").length;
  const reload = () => { list.reload(); drops.reload(); };

  const openEditor = (s: any) =>
    setEditing({
      id: s.id, employeeId: s.employeeId ?? "", date: ymd(new Date(s.startsAt)), start: hm(s.startsAt), end: hm(s.endsAt),
      position: s.position ?? "", location: s.location ?? "", assetId: s.assetId ?? "", notes: s.notes ?? "", status: s.status,
    });

  const chipClick = (s: any) => {
    if (manager) return openEditor(s);
    if (!s.employeeId && s.status === "published") {
      if (confirm(`Pick up this shift on ${new Date(s.startsAt).toLocaleDateString()}?`)) {
        action.run(async () => { await api(`/shifts/${s.id}/claim`, { method: "POST" }); setNotice("Shift picked up. It's on your schedule."); reload(); });
      }
    } else if (s.employeeId === me?.user.id && !s.dropRequestedAt) {
      const reason = prompt("Ask your manager to take you off this shift. Reason (optional):");
      if (reason !== null) action.run(async () => { await api(`/shifts/${s.id}/drop-request`, { body: { reason: reason || undefined } }); setNotice("Request sent to your manager."); reload(); });
    }
  };

  const Chip = ({ s }: { s: any }) => {
    const clickable = manager || (!s.employeeId && s.status === "published") || (s.employeeId === me?.user.id && !s.dropRequestedAt);
    return (
      <div className={`shift ${s.status === "draft" ? "draft" : ""} ${!s.employeeId ? "open" : ""} ${s.employeeId === me?.user.id ? "mine" : ""}`}
        onClick={() => clickable && chipClick(s)} style={{ cursor: clickable ? "pointer" : "default" }}
        title={[s.position, s.location, s.assetName, s.notes].filter(Boolean).join(" · ")}>
        <strong>{time(s.startsAt)}–{time(s.endsAt)}</strong>
        {s.position && <div>{s.position}</div>}
        {s.assetName && <div className="muted">🚚 {s.assetName}</div>}
        {s.dropRequestedAt && <Badge value="drop requested" />}
      </div>
    );
  };

  /** The employee's "can't work" rules that touch this day, for shading the cell. */
  const blockedOn = (employeeId: string | null, day: Date) =>
    employeeId ? availabilityConflicts((unavailable.data ?? []).filter((r) => r.employeeId === employeeId), [{ weekday: day.getDay(), from: 0, to: 1440 }]) : [];

  const cell = (employeeId: string | null, day: Date) => {
    const blocked = blockedOn(employeeId, day);
    return (
    <td key={day.toISOString()} className={`shiftcell ${blocked.length ? "unavail" : ""}`}>
      {blocked.map((r, i) => <div key={i} className="unavail-label" title={r.note ?? ""}>Can&apos;t work {describeRule(r).toLowerCase()}</div>)}
      {shownShifts(employeeId).filter((s) => sameDay(new Date(s.startsAt), day)).map((s) => <Chip key={s.id} s={s} />)}
      {manager && (
        <button className="addshift" title="Add shift" onClick={() => setEditing({ employeeId: employeeId ?? "", date: ymd(day), start: "08:00", end: "16:30" })}>+</button>
      )}
    </td>
    );
  };

  const everyone = manager ? staff : [...staff.filter((e) => e.id === me?.user.id), ...staff.filter((e) => e.id !== me?.user.id && allShifts.some((s) => s.employeeId === e.id))];
  const hasShift = (id: string) => shifts.some((s) => s.employeeId === id);
  const rows = everyone.filter((e) =>
    (!filters.title || e.title === filters.title) &&
    (!filters.dept || e.department === filters.dept) &&
    (!filters.show || (filters.show === "scheduled" ? allShifts.some((s) => s.employeeId === e.id) : !allShifts.some((s) => s.employeeId === e.id))) &&
    // With a shift filter on, only people who have a matching shift; a search also matches their name and title.
    (!shiftFiltered || hasShift(e.id)) &&
    (!q || hasShift(e.id) || `${e.firstName} ${e.lastName} ${e.title ?? ""}`.toLowerCase().includes(q)));
  // Someone whose own name or title matches the search shows all their shifts, not just matching ones.
  const nameHit = (id: string | null) => !!q && !!id && `${nameOf(id)} ${staff.find((x) => x.id === id)?.title ?? ""}`.toLowerCase().includes(q);
  const shownShifts = (employeeId: string | null) =>
    (nameHit(employeeId) ? allShifts.filter((s) => !shiftFiltered || shifts.includes(s)) : shifts).filter((s) => (s.employeeId ?? null) === employeeId);
  const showOpenRow = !filters.title && !filters.dept && !filters.show && (!filtering || shifts.some((s) => !s.employeeId));
  const withMenu = (menu: string[], inUse: string[]) => [...menu, ...inUse.filter((v) => !menu.includes(v))];
  const titles = withMenu(menus.jobTitles, distinct(everyone.map((e) => e.title)));
  const depts = withMenu(menus.departments, distinct(everyone.map((e) => e.department)));
  const positions = distinct(allShifts.map((s) => s.position));
  const locations = distinct(allShifts.map((s) => s.location));
  const shiftAssets = distinct(allShifts.map((s) => s.assetId)).map((id) => ({ id, name: allShifts.find((s) => s.assetId === id)?.assetName ?? "Unknown" })).sort((a, b) => a.name.localeCompare(b.name));
  const pick = (labelText: string, key: keyof Filters, options: { value: string; label: string }[], all = "All") => (
    <label>{labelText}
      <select value={filters[key]} onChange={(e) => setFilter({ [key]: e.target.value })}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  const asOptions = (l: string[]) => l.map((v) => ({ value: v, label: v }));

  return (
    <>
      <PageHead title="Schedule" sub={`Week of ${from.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}`}>
        <WeekPicker week={from} onChange={(monday) => setOffset(Math.round((monday.getTime() - weekStart(0).getTime()) / (7 * DAY)))} />
        {partTime && <button className="btn" onClick={() => setShowAvailability(!showAvailability)}>My availability</button>}
        {manager && <button className="btn primary" onClick={() => {
          // Today if it's in the week being shown, otherwise that week's Monday.
          const today = new Date();
          const day = today >= from && today < to ? today : from;
          setEditing({ employeeId: "", date: ymd(day), start: "08:00", end: "16:30" });
        }}>+ Add shift</button>}
        {manager && <button className="btn" onClick={() => setShowTemplates(!showTemplates)}>Templates{templates.data?.length ? ` (${templates.data.length})` : ""}</button>}
        {manager && (
          <>
            <button className="btn" disabled={action.busy} onClick={() => confirm("Copy last week's shifts into this week as drafts?") && action.run(async () => {
              const r = await api("/shifts/copy-week", { body: { from: weekStart(offset - 1).toISOString(), to: from.toISOString() } });
              setNotice(`Copied ${r.copied} shift${r.copied === 1 ? "" : "s"}${r.skipped ? `; skipped ${r.skipped} that would double-book someone` : ""}.`);
              reload();
            })}>Copy last week</button>
            <button className="btn primary" disabled={!drafts || action.busy} onClick={() => action.run(async () => {
              const r = await api("/shifts/publish", { body: { from: from.toISOString(), to: to.toISOString() } });
              setNotice(`Published ${r.published} shift${r.published === 1 ? "" : "s"}. Your team has been notified.`);
              reload();
            })}>Publish{drafts ? ` (${drafts})` : ""}</button>
          </>
        )}
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter the schedule" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder="Name, position, site…" value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        {pick("Job title", "title", asOptions(titles))}
        {pick("Department", "dept", asOptions(depts))}
        {pick("Position", "position", asOptions(positions))}
        {pick("Location / job site", "location", asOptions(locations))}
        {pick("Vehicle / equipment", "asset", shiftAssets.map((a) => ({ value: a.id, label: a.name })))}
        {manager && pick("Shift status", "status", [{ value: "draft", label: "Drafts" }, { value: "published", label: "Published" }])}
        {pick("Show", "show", [{ value: "scheduled", label: "People with shifts this week" }, { value: "unscheduled", label: "People with no shifts this week" }], "Everyone")}
        {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </form>
      <ErrorBox error={action.error || list.error} />
      {notice && <div className="card row" style={{ justifyContent: "space-between" }}><span>{notice}</span><button className="btn sm" onClick={() => setNotice(null)}>×</button></div>}
      {editing && (
        <ShiftEditor key={editing.id ?? `${editing.employeeId}-${editing.date}`} draft={editing} weekDays={days} employees={staff} assets={assets.data ?? []}
          templates={templates.data ?? []} onTemplatesChanged={() => { templates.reload(); setNotice("Template saved."); }} onClose={() => setEditing(null)}
          onSaved={(w) => { setEditing(null); setNotice(w.length ? `Saved. ${w.map((x) => x[0].toUpperCase() + x.slice(1)).join(". ")}.` : null); reload(); }} />
      )}
      {manager && !editing && list.data && !allShifts.length && !filtering && (
        <div className="card">
          <h2>Make this week&apos;s schedule</h2>
          <ol className="stack" style={{ paddingLeft: 18, margin: 0 }}>
            {staff.length <= 1 && <li>Add your team under <Link href="/people">Team</Link>, so they show up here to schedule.</li>}
            <li>Click <strong>+ Add shift</strong> above, or the <strong>+</strong> in anyone&apos;s row under a day. Shifts in the <strong>Open shifts</strong> row can be picked up by anyone.</li>
            <li>Shifts start as drafts that only managers see. When the week looks right, click <strong>Publish</strong> to share it and notify your team.</li>
            <li>Next week, <strong>Copy last week</strong> brings these shifts forward as drafts, and <strong>Templates</strong> save shifts you use often.</li>
          </ol>
        </div>
      )}
      {partTime && showAvailability && (
        <div className="card">
          <h2>When I can&apos;t work</h2>
          <p className="muted" style={{ marginTop: 0 }}>Recurring times you&apos;re unavailable. For specific days off, request time off instead.</p>
          <AvailabilityEditor onSaved={unavailable.reload} />
        </div>
      )}
      {showTemplates && manager && (
        <div className="card">
          <h2>Shift templates</h2>
          {templates.data?.length ? (
            <table><tbody>{templates.data.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong></td>
                <td>{t.startTime}–{t.endTime}{t.endTime <= t.startTime ? " (overnight)" : ""}</td>
                <td className="muted">{[t.position, t.location, assets.data?.find((a) => a.id === t.assetId)?.name].filter(Boolean).join(" · ")}</td>
                <td className="row"><button className="btn sm danger" onClick={() => confirm(`Delete template "${t.name}"?`) && api(`/shifts/templates/${t.id}`, { method: "DELETE" }).then(templates.reload)}>Delete</button></td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No templates yet. Open any shift and click &ldquo;Save as template&rdquo;.</Empty>}
        </div>
      )}
      {manager && !!drops.data?.length && (
        <div className="card">
          <h2>Drop requests</h2>
          <table><tbody>{drops.data.map(({ shift: s, employee }) => (
            <tr key={s.id}>
              <td>{employee.firstName} {employee.lastName}<div className="muted">{s.dropReason ?? "No reason given"}</div></td>
              <td>{new Date(s.startsAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, {time(s.startsAt)}–{time(s.endsAt)}</td>
              <td className="row">
                <button className="btn sm primary" onClick={() => action.run(async () => { await api(`/shifts/${s.id}/drop-decision`, { body: { approve: true } }); reload(); })}>Approve (make open)</button>
                <button className="btn sm" onClick={() => action.run(async () => { await api(`/shifts/${s.id}/drop-decision`, { body: { approve: false } }); reload(); })}>Deny</button>
              </td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
      <div className="card tablewrap" style={{ padding: 0 }}>
        <table className="schedule">
          <thead>
            <tr>
              <th>Employee</th>
              {days.map((d) => (
                <th key={d.toISOString()} className={sameDay(d, new Date()) ? "today" : ""}>
                  {d.toLocaleDateString([], { weekday: "short" })} <span className="muted">{d.getMonth() + 1}/{d.getDate()}</span>
                  {weekHolidays.data?.upcoming.filter((h) => h.observed === ymd(d)).map((h) => (
                    <div key={h.holidayId} className="holiday-tag" title={h.date !== h.observed ? `Observed for ${h.name} (${h.date})` : "Paid holiday"}>🎉 {h.name}</div>
                  ))}
                </th>
              ))}
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {showOpenRow && <tr className="openrow">
              <td><strong>Open shifts</strong><div className="muted">{manager ? "Anyone can claim" : "Click to pick up"}</div></td>
              {days.map((d) => cell(null, d))}
              <td />
            </tr>}
            {rows.map((e) => {
              const total = allShifts.filter((s) => s.employeeId === e.id).reduce((h, s) => h + hours(s), 0);
              return (
                <tr key={e.id}>
                  <td><strong>{e.firstName} {e.lastName}</strong><div className="muted">{e.title ?? ""}</div></td>
                  {days.map((d) => cell(e.id, d))}
                  <td style={{ color: total > 40 ? "var(--warn)" : undefined, fontWeight: 600 }} title={total > 40 ? "Scheduled into overtime" : ""}>
                    {total ? total.toFixed(1) : "—"}{total > 40 && " ⚠"}
                  </td>
                </tr>
              );
            })}
            {filtering && !rows.length && !showOpenRow && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: "center", padding: 20 }}>Nothing this week matches your filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {manager
          ? "Dashed shifts are drafts only you can see. Publish to share them and notify your team. Striped cells are times someone can't work."
          : "Click one of your shifts to ask to drop it, or an open shift to pick it up."}
      </p>
    </>
  );
}
