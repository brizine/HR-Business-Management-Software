"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isInactive } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { AttendanceCalendar, AttendanceReport, AttendanceRulesForm } from "@/components/attendance";

type Tab = "calendar" | "report" | "settings";

function Attendance() {
  const { me, can } = useAuth();
  const manager = can("manager", "time");
  const params = useSearchParams();
  const staff = useApi<any[]>(manager ? "/employees" : null);
  const [tab, setTab] = useState<Tab>("calendar");
  const [person, setPerson] = useState<string | null>(params.get("employee"));
  useEffect(() => { if (params.get("employee")) { setPerson(params.get("employee")); setTab("calendar"); } }, [params]);
  const [f, setF] = useState({ q: "", title: "", dept: "", show: "" });
  const setFilter = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const filtering = !!(f.q || f.title || f.dept || f.show);
  const everyone = (staff.data ?? []).filter((e) => !isInactive(e.status) || e.id === person);
  const q = f.q.trim().toLowerCase();
  const people = everyone.filter((e) =>
    (!q || `${e.firstName} ${e.lastName} ${e.title ?? ""} ${e.department ?? ""}`.toLowerCase().includes(q)) &&
    (!f.title || e.title === f.title) && (!f.dept || e.department === f.dept));
  const distinct = (k: string) => [...new Set(everyone.map((e) => e[k]).filter(Boolean))].sort() as string[];
  // The chosen person, or the first who matches the search and filters.
  const shown = manager ? (person && people.some((e) => e.id === person) ? person : people[0]?.id) : me?.user.id;
  const tabs: [Tab, string][] = manager ? [["calendar", "Calendar"], ["report", "Report"], ["settings", "Rules & settings"]] : [["calendar", "My attendance"], ["settings", "Rules"]];

  return (
    <>
      <PageHead title="Attendance" sub={manager ? "Scheduled shifts compared with punches and time off. Green: worked as scheduled · yellow: late or left early · red: no-show · blue: called in sick." : "Your scheduled days compared with your punches. Green: worked as scheduled · yellow: late or left early · red: no-show · blue: called in sick."}>
        <div className="row" role="tablist" style={{ gap: 6 }}>
          {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHead>
      {tab === "report" && manager && <AttendanceReport onOpen={(id) => { setPerson(id); setTab("calendar"); }} />}
      {tab === "calendar" && (
        <>
          <form className="card filters" role="search" aria-label="Filter the attendance calendar" onSubmit={(e) => e.preventDefault()}>
            {manager && (
              <>
                <label>Search<input type="search" placeholder="Name, job title, department…" value={f.q} onChange={(e) => setFilter({ q: e.target.value })} /></label>
                <label>Job title
                  <select value={f.title} onChange={(e) => setFilter({ title: e.target.value })}>
                    <option value="">All</option>
                    {distinct("title").map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>Department
                  <select value={f.dept} onChange={(e) => setFilter({ dept: e.target.value })}>
                    <option value="">All</option>
                    {distinct("department").map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>Employee
                  <select value={shown ?? ""} onChange={(e) => setPerson(e.target.value)} disabled={!people.length}>
                    {!people.length && <option value="">No one matches</option>}
                    {people.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}{e.title ? ` · ${e.title}` : ""}</option>)}
                  </select>
                </label>
              </>
            )}
            <label>Show days
              <select value={f.show} onChange={(e) => setFilter({ show: e.target.value })}>
                <option value="">All days</option>
                <option value="on_time">Worked as scheduled</option>
                <option value="late">Late or left early</option>
                <option value="no_show">No-shows</option>
                <option value="sick">Called in sick</option>
                <option value="excused">Excused / time off</option>
                <option value="points">Days with points</option>
                <option value="changed">Changed by an owner/admin</option>
              </select>
            </label>
            {filtering && <button type="button" className="btn" onClick={() => setF({ q: "", title: "", dept: "", show: "" })}>Clear filters</button>}
          </form>
          <div className="card stack">
            {manager && shown && <h2 style={{ margin: 0 }}>{(() => { const p = everyone.find((e) => e.id === shown); return p ? `${p.firstName} ${p.lastName}` : ""; })()}</h2>}
            {shown ? <AttendanceCalendar employeeId={shown} highlight={f.show} /> : <p className="muted" style={{ margin: 0 }}>No one matches your search.</p>}
          </div>
        </>
      )}
      {tab === "settings" && <AttendanceRulesForm />}
    </>
  );
}

export default function Page() {
  return <Suspense><Attendance /></Suspense>;
}
