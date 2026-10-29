"use client";
import Link from "next/link";
import { useState } from "react";
import { APPLICANT_STAGES } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";

export default function Hiring() {
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

  const hire = (a: any) => {
    const tpl = templates.data?.[0];
    const msg = tpl ? `Hire ${a.firstName} ${a.lastName} and start the "${tpl.name}" checklist?` : `Hire ${a.firstName} ${a.lastName}?`;
    if (!confirm(msg)) return;
    api(`/applicants/${a.id}/hire`, { body: { onboardingTemplateId: tpl?.id } }).then(applicants.reload, (e) => alert(e.message));
  };

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
              <label>Department<input name="department" /></label>
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
                      {stage === "offer" && can("admin") && <button className="btn sm primary" onClick={() => hire(a)}>Hire</button>}
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
