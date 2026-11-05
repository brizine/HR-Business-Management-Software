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
  const [tab, setTab] = useState<Tab>(params.get("employee") || !manager ? "calendar" : "report");
  const [person, setPerson] = useState<string | null>(params.get("employee"));
  useEffect(() => { if (params.get("employee")) { setPerson(params.get("employee")); setTab("calendar"); } }, [params]);
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status) || e.id === person);
  const shown = manager ? person ?? people[0]?.id ?? me?.user.id : me?.user.id;
  const tabs: [Tab, string][] = manager ? [["report", "Report"], ["calendar", "Calendar"], ["settings", "Settings"]] : [["calendar", "My attendance"], ["settings", "Rules"]];

  return (
    <>
      <PageHead title="Attendance" sub={manager ? "Scheduled shifts compared with punches and time off. Green: worked as scheduled · yellow: late or left early · red: no-show · blue: called in sick." : "Your scheduled days compared with your punches. Green: worked as scheduled · yellow: late or left early · red: no-show · blue: called in sick."}>
        <div className="row" role="tablist" style={{ gap: 6 }}>
          {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHead>
      {tab === "report" && manager && <AttendanceReport onOpen={(id) => { setPerson(id); setTab("calendar"); }} />}
      {tab === "calendar" && shown && (
        <div className="card stack">
          {manager && (
            <label style={{ maxWidth: 320 }}>Employee
              <select value={shown} onChange={(e) => setPerson(e.target.value)}>
                {people.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}{e.title ? ` · ${e.title}` : ""}</option>)}
              </select>
            </label>
          )}
          <AttendanceCalendar employeeId={shown} />
        </div>
      )}
      {tab === "settings" && <AttendanceRulesForm />}
    </>
  );
}

export default function Page() {
  return <Suspense><Attendance /></Suspense>;
}
