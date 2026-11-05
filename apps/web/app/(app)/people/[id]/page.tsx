"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { DocumentList } from "@/components/documents";
import { InviteResult } from "@/components/invite-result";
import { OnboardingTask } from "@/components/onboarding-task";
import { DownloadPdf, FormStatus, signedLine } from "@/components/tax-form-bits";
import { AvailabilityEditor } from "@/components/availability-editor";
import { EmployeeFields, employeeBody } from "@/components/employee-form";
import { ProfileDetails } from "@/components/profile-details";
import { PhotoEditor } from "@/components/avatar";
import { RequestTimeOffBox } from "@/components/request-time-off";
import { ClockCard } from "@/components/clock-card";
import { ClockStatusBox } from "@/components/clock-status";
import { EmployeeRecordsBox } from "@/components/employee-records";
import { AttendanceCalendar } from "@/components/attendance";
import { TasksBox } from "@/components/tasks-box";
import { isInactive } from "@crewdesk/shared";

/** Admins: the person's W-4, I-9 and direct deposit on file (current and earlier versions). */
function EmployeeTaxForms({ employeeId }: { employeeId: string }) {
  const { data } = useApi<any[]>(`/tax-forms?employeeId=${employeeId}`);
  if (!data) return null;
  return (
    <div className="card">
      <h2>Pay & tax forms</h2>
      {data.length ? (
        <table><tbody>{data.map((f) => (
          <tr key={f.id} style={{ opacity: f.supersededAt ? 0.6 : 1 }}>
            <td><Link href={`/tax-forms/${f.id}`}>{f.label}</Link>{f.supersededAt && <span className="muted"> (earlier version)</span>}<div className="muted">{f.summary} · {signedLine(f)}</div></td>
            <td className="row" style={{ textAlign: "right" }}><FormStatus form={f} /> <DownloadPdf form={f} /></td>
          </tr>
        ))}</tbody></table>
      ) : <p className="muted" style={{ margin: 0 }}>None filled out in Crewdesk yet.</p>}
    </div>
  );
}

export default function Person({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me, can } = useAuth();
  const emp = useApi(`/employees/${id}`);
  const all = useApi<any[]>(can("manager", "people") ? "/employees" : null);
  // Each person sees their own accrued time off here; managers and up see everyone's.
  const balances = useApi<any[]>(can("manager", "timeoff") || id === me?.user.id ? `/pto/balances?employeeId=${id}` : null);
  const tasks = useApi<any[]>(can("manager", "onboarding") ? `/onboarding/tasks?employeeId=${id}` : null);
  const templates = useApi<any[]>(can("admin", "onboarding") ? "/onboarding/templates" : null);
  const [editing, setEditing] = useState(false);
  const [invite, setInvite] = useState<{ emailed: boolean; link: string } | null>(null);
  const { busy, error, run } = useAction();
  const e = emp.data;
  if (!e) return <ErrorBox error={emp.error} />;
  const by = (all.data ?? []).find((x: any) => x.id === e.statusChangedById);
  const changedBy = by ? `${by.firstName} ${by.lastName}` : null;

  return (
    <>
      <PageHead title={`${e.firstName} ${e.lastName}`} sub={[e.title, e.department].filter(Boolean).join(" · ")}
        before={<PhotoEditor e={e} canEdit={can("admin", "people") || e.id === me?.user.id} onChange={emp.setData} />}>
        <Badge value={e.status} menu="employeeStatus" />
        {can("admin", "people") && e.id !== me?.user.id && e.hasLogin && (
          <button className="btn" onClick={() => confirm(`Sign ${e.firstName} out of Crewdesk on every device?`)
            && api(`/employees/${id}/sign-out-everywhere`, { method: "POST" }).then(() => alert("Signed out everywhere."), (err) => alert(err.message))}>Sign out everywhere</button>
        )}
        {can("admin", "people") && <Link className="btn" href={`/settings/notifications?employeeId=${id}`}>Notifications</Link>}
        {can("admin", "people") && <button className="btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>}
      </PageHead>
      {editing ? (
        <div className="card">
          <form
            className="stack"
            onSubmit={(ev) => {
              ev.preventDefault();
              const body = employeeBody(ev.currentTarget);
              run(async () => {
                emp.setData(await api(`/employees/${id}`, { method: "PATCH", body }));
                setEditing(false);
              });
            }}
          >
            <EmployeeFields initial={e} employees={all.data ?? []} />
            <ErrorBox error={error} />
            <div><button className="btn primary" disabled={busy}>Save changes</button></div>
          </form>
        </div>
      ) : (
        <div className="card">
          <ProfileDetails e={e} />
          {isInactive(e.status) && "statusReason" in e && (
            <div className="status-reason">
              <div className="muted">
                Reason {e.status === "terminated" ? "for termination" : "they're inactive"}
                {e.statusChangedAt && <> · {e.status} {fmtDate(e.statusChangedAt)}{changedBy ? ` by ${changedBy}` : ""}</>}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{e.statusReason || <span className="muted">No reason given. Click Edit to add one.</span>}</div>
            </div>
          )}
        </div>
      )}
      {can("admin", "people") && !e.hasLogin && !isInactive(e.status) && (
        <div className="card stack">
          <div className="row">
            <strong style={{ marginRight: 8 }}>Account</strong>
            <span className="muted">{e.invitedAt ? `Invited ${fmtDate(e.invitedAt)}, hasn't set up their login yet.` : "No login yet."}</span>
            <button className="btn" onClick={() => api(`/employees/${id}/invite`, { method: "POST" }).then((inv) => { setInvite(inv); emp.reload(); }, (err) => alert(err.message))}>
              {e.invitedAt ? "Resend invite" : "Send invite"}
            </button>
          </div>
          {invite && <InviteResult invite={invite} name={e.firstName} email={e.email} />}
        </div>
      )}
      {can("admin", "people") && e.id !== me?.user.id && e.hasLogin && (e.twoFactorEnabled || e.locked) && (
        <div className="card row">
          <strong style={{ marginRight: 8 }}>Account</strong>
          {e.twoFactorEnabled && (
            <button className="btn" onClick={() => confirm(`Reset ${e.firstName}'s two-factor? Only do this if you've confirmed it's really them (e.g. in person). They'll be signed out and can set it up again.`)
              && api(`/employees/${id}/reset-two-factor`, { method: "POST" }).then(emp.reload, (err) => alert(err.message))}>Reset two-factor</button>
          )}
          {e.locked && <button className="btn" onClick={() => api(`/employees/${id}/unlock`, { method: "POST" }).then(emp.reload, (err) => alert(err.message))}>Unlock</button>}
        </div>
      )}
      <div className="grid cols-2">
        {/* Your own page: clock in or out. Someone else's (time clock managers): whether they're on the clock. */}
        {!isInactive(e.status) && (e.id === me?.user.id ? <ClockCard title="Clock in" /> : can("manager", "time") && <ClockStatusBox employeeId={e.id} firstName={e.firstName} />)}
        {balances.data && (
          <div className="card">
            <h2>Accrued Time Off</h2>
            {balances.data.length ? (
              <div className="stats" style={{ marginBottom: 0 }}>
                {balances.data.map((b) => (
                  <div className="stat" key={b.policyId}>
                    <div className="v">{b.balanceHours}h</div>
                    <div className="l">{b.name}{b.pendingHours ? ` · ${b.pendingHours}h pending` : ""}</div>
                  </div>
                ))}
              </div>
            ) : <Empty>No time off accrued yet.</Empty>}
          </div>
        )}
        {(can("manager", "people") || e.id === me?.user.id) && !isInactive(e.status) && (
          <TasksBox employeeId={e.id} firstName={e.firstName} isSelf={e.id === me?.user.id} />
        )}
        {(can("manager", "timeoff") || e.id === me?.user.id) && !isInactive(e.status) && (
          <RequestTimeOffBox employeeId={e.id} firstName={e.firstName} isSelf={e.id === me?.user.id} balances={balances.data} onChange={balances.reload} />
        )}
        {tasks.data && (
          <div className="card">
            <h2>Onboarding</h2>
            {tasks.data.length ? (
              <table><tbody>
                {tasks.data.map((t) => <OnboardingTask key={t.id} task={t} mode="manager" onChange={tasks.reload} />)}
              </tbody></table>
            ) : (
              <>
                <Empty>No onboarding checklist.</Empty>
                {templates.data?.length ? (
                  <div className="row">
                    <select id="tpl">{templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                    <button className="btn" onClick={() => {
                      const templateId = (document.getElementById("tpl") as HTMLSelectElement).value;
                      api("/onboarding/assign", { body: { employeeId: id, templateId } }).then(tasks.reload);
                    }}>Assign checklist</button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
      {(can("manager", "time") || e.id === me?.user.id) && (
        <div className="card stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Attendance</h2>
            <a className="muted" style={{ fontSize: 13 }} href={can("manager", "time") ? `/attendance?employee=${e.id}` : "/attendance"}>Full attendance →</a>
          </div>
          <AttendanceCalendar employeeId={e.id} compact />
        </div>
      )}
      {(can("manager", "reviews") || e.id === me?.user.id) && <EmployeeRecordsBox employeeId={e.id} firstName={e.firstName} isSelf={e.id === me?.user.id} />}
      {/* Availability is only tracked for part-time employees. */}
      {can("manager", "schedule") && e.employmentType === "part_time" && (
        <div className="card">
          <h2>Availability</h2>
          <p className="muted" style={{ marginTop: 0 }}>Recurring times {e.firstName} can&apos;t work. These show on the schedule and warn you when scheduling.</p>
          <AvailabilityEditor employeeId={id} />
        </div>
      )}
      {can("admin", "payroll") && <EmployeeTaxForms employeeId={id} />}
      <DocumentList employeeId={id} />
    </>
  );
}
