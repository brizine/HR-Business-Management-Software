"use client";
import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox, formValues } from "@/components/ui";

/** Public job board a business can link from its website. */
export default function Careers({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [data, setData] = useState<any>(null);
  const [applyTo, setApplyTo] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api(`/public/${companyId}/jobs`).then(setData, () => setData({ error: true }));
  }, [companyId]);

  if (!data) return null;
  if (data.error) return <div className="authwrap"><p>This careers page is not available.</p></div>;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px" }}>
      <h1>Careers at {data.company.name}</h1>
      <p className="muted">{data.jobs.length} open position{data.jobs.length === 1 ? "" : "s"}</p>
      {data.jobs.map((j: any) => (
        <div className="card" key={j.id}>
          <h2>{j.title}</h2>
          <div className="muted">{[j.department, j.location, j.payRange].filter(Boolean).join(" · ")}</div>
          <p style={{ whiteSpace: "pre-wrap" }}>{j.description}</p>
          {applied.includes(j.id) ? <p><strong>Thanks! Your application was received.</strong></p>
            : applyTo === j.id ? (
              <form className="stack" onSubmit={(e) => {
                e.preventDefault();
                const body = formValues(e.currentTarget);
                run(async () => { await api(`/public/jobs/${j.id}/apply`, { body }); setApplied([...applied, j.id]); setApplyTo(null); });
              }}>
                <div className="formgrid">
                  <label>First name<input name="firstName" required /></label>
                  <label>Last name<input name="lastName" required /></label>
                  <label>Email<input name="email" type="email" required /></label>
                  <label>Phone<input name="phone" /></label>
                </div>
                <label>Tell us about your experience<textarea name="notes" /></label>
                <ErrorBox error={error} />
                <div><button className="btn primary" disabled={busy}>Submit application</button></div>
              </form>
            ) : <button className="btn primary" onClick={() => setApplyTo(j.id)}>Apply</button>}
        </div>
      ))}
    </div>
  );
}
