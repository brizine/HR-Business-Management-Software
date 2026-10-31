"use client";
import Link from "next/link";
import { useState } from "react";
import { APPLICANT_STAGES, EMPLOYMENT_TYPES, PAY_TYPES, isInactive } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";
import { InviteResult } from "@/components/invite-result";
import { MenuSelect, useMenus } from "@/components/menu-select";

/** Details for a new hire: start date, pay, manager, checklist and invite. */
function HireForm({ applicant, job, templates, staff, onCancel, onHired }: {
  applicant: any; job: any; templates: any[]; staff: any[]; onCancel: () => void; onHired: (res: any) => void;
}) {
  const menus = useMenus();
  const { me } = useAuth();
  const { busy, error, run } = useAction();
  const managers = staff.filter((e) => ["manager", "admin", "owner"].includes(e.role) && !isInactive(e.status));
  return (
    <div className="card">
      <h2>Hire {applicant.firstName} {applicant.lastName}</h2>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        const { payRate, onboardingTemplateId, managerId, sendInvite, ...v } = formValues(e.currentTarget);
        run(async () => onHired(await api(`/applicants/${applicant.id}/hire`, { body: {
          ...v,
          payRateCents: Math.round((payRate ?? 0) * 100),
          onboardingTemplateId: onboardingTemplateId ?? null,
          managerId: managerId ?? null,
          sendInvite: !!sendInvite,
        } })));
      }}>
        <div className="formgrid">
          <label>Start date<input name="startDate" type="date" required /></label>
          <MenuSelect name="title" label="Job title" options={menus.jobTitles} current={job?.title} />
          <MenuSelect name="department" label="Department" options={menus.departments} current={job?.department} />
          <label>Manager
            <select name="managerId" defaultValue={managers.find((m) => m.id === me?.user.id) ? me?.user.id : ""}>
              <option value="">—</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
            </select>
          </label>
          <label>Employment<select name="employmentType" defaultValue="full_time">{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select></label>
          <label>Pay type<select name="payType" defaultValue="hourly">{PAY_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Pay rate ($/hr or $/yr)<input name="payRate" type="number" step="0.01" min="0" required /></label>
          <label>Role in Crewdesk<select name="role" defaultValue="employee"><option value="employee">employee</option><option value="manager">manager</option></select></label>
          <label>Onboarding checklist
            <select name="onboardingTemplateId" defaultValue={templates[0]?.id ?? ""}>
              <option value="">None</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.tasks.length} tasks)</option>)}
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" name="sendInvite" defaultChecked /> Email {applicant.firstName} an invite to set up their account ({applicant.email})</label>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy}>Hire {applicant.firstName}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export default function Hiring() {
  const menus = useMenus();
  const { me, can } = useAuth();
  const jobs = useApi<any[]>("/jobs");
  const [jobId, setJobId] = useState<string | null>(null);
  const applicants = useApi<any[]>(jobId ? `/applicants?jobId=${jobId}` : null);
  const templates = useApi<any[]>(can("admin") ? "/onboarding/templates" : null);
  const [creating, setCreating] = useState(false);
  const [addingApplicant, setAddingApplicant] = useState(false);
  const jobAction = useAction();
  const appAction = useAction();
  const job = jobs.data?.find((j) => j.id === jobId);

  const [hiring, setHiring] = useState<any>(null);
  const [hired, setHired] = useState<any>(null);
  const staff = useApi<any[]>(can("admin") ? "/employees" : null);

  return (
    <>
      <PageHead title="Hiring" sub={<>Public careers page: <Link href={`/careers/${me?.company.id}`} target="_blank">/careers/{me?.company.id.slice(0, 8)}…</Link></>}>
        <button className="btn primary" onClick={() => setCreating(!creating)}>Post a job</button>
      </PageHead>
      {creating && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            jobAction.run(async () => { const j = await api("/jobs", { body }); setCreating(false); await jobs.reload(); setJobId(j.id); });
          }}>
            <div className="formgrid">
              <label>Title<input name="title" required /></label>
              <MenuSelect name="department" label="Department" options={menus.departments} />
              <label>Location<input name="location" /></label>
              <label>Pay range<input name="payRange" placeholder="$20–$25/hr" /></label>
            </div>
            <label>Description<textarea name="description" /></label>
            <ErrorBox error={jobAction.error} />
            <div><button className="btn primary" disabled={jobAction.busy}>Publish</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        {jobs.data?.length ? (
          <table>
            <thead><tr><th>Job</th><th>Location</th><th>Status</th><th /></tr></thead>
            <tbody>{jobs.data.map((j) => (
              <tr key={j.id} style={{ background: j.id === jobId ? "var(--info-bg)" : undefined }}>
                <td><strong>{j.title}</strong><div className="muted">{j.department}</div></td>
                <td>{j.location ?? "—"}</td>
                <td><Badge value={j.status} /></td>
                <td className="row">
                  <button className="btn sm" onClick={() => setJobId(j.id)}>Pipeline</button>
                  <button className="btn sm" onClick={() => api(`/jobs/${j.id}`, { method: "PATCH", body: { status: j.status === "open" ? "closed" : "open" } }).then(jobs.reload)}>
                    {j.status === "open" ? "Close" : "Reopen"}
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No jobs yet.</Empty>}
      </div>
      {hiring && (
        <HireForm applicant={hiring} job={job} templates={templates.data ?? []} staff={staff.data ?? []}
          onCancel={() => setHiring(null)}
          onHired={(res) => { setHiring(null); setHired(res); applicants.reload(); }} />
      )}
      {hired && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>{hired.firstName} {hired.lastName} is hired 🎉</h2>
            <button className="btn sm" onClick={() => setHired(null)}>Close</button>
          </div>
          <p className="muted">{hired.tasks ? `Their ${hired.tasks}-task onboarding checklist has started.` : "No checklist was started."} <Link href={`/people/${hired.id}`}>Open their profile</Link></p>
          <InviteResult invite={hired.invite} name={hired.firstName} email={hired.email} />
        </div>
      )}
      {job && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{job.title}: applicants</h2>
            <button className="btn" onClick={() => setAddingApplicant(!addingApplicant)}>Add applicant</button>
          </div>
          {addingApplicant && (
            <div className="card">
              <form className="stack" onSubmit={(e) => {
                e.preventDefault();
                const body = formValues(e.currentTarget);
                appAction.run(async () => { await api(`/jobs/${job.id}/applicants`, { body }); setAddingApplicant(false); applicants.reload(); });
              }}>
                <div className="formgrid">
                  <label>First name<input name="firstName" required /></label>
                  <label>Last name<input name="lastName" required /></label>
                  <label>Email<input name="email" type="email" required /></label>
                  <label>Phone<input name="phone" /></label>
                </div>
                <label>Notes<textarea name="notes" /></label>
                <ErrorBox error={appAction.error} />
                <div><button className="btn primary" disabled={appAction.busy}>Add</button></div>
              </form>
            </div>
          )}
          <div className="kanban">
            {APPLICANT_STAGES.map((stage) => (
              <div className="kcol" key={stage}>
                <strong>{stage[0].toUpperCase() + stage.slice(1)}</strong>{" "}
                <span className="muted">{applicants.data?.filter((a) => a.stage === stage).length ?? 0}</span>
                {applicants.data?.filter((a) => a.stage === stage).map((a) => (
                  <div className="kcard" key={a.id}>
                    <div><strong>{a.firstName} {a.lastName}</strong></div>
                    <div className="muted">{a.email}</div>
                    {a.notes && <div className="muted">{a.notes}</div>}
                    <div className="row" style={{ marginTop: 6 }}>
                      {stage !== "hired" && (
                        <select value={a.stage} onChange={(e) => api(`/applicants/${a.id}/stage`, { method: "PATCH", body: { stage: e.target.value } }).then(applicants.reload)} style={{ width: "auto", padding: "3px 6px" }}>
                          {APPLICANT_STAGES.filter((s) => s !== "hired").map((s) => <option key={s}>{s}</option>)}
                        </select>
                      )}
                      {stage === "offer" && can("admin") && <button className="btn sm primary" onClick={() => { setHired(null); setHiring(a); }}>Hire</button>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
