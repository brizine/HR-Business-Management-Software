"use client";
import Link from "next/link";
import { TAX_FORM_LABELS, TAX_FORM_TYPES } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Empty, PageHead } from "@/components/ui";
import { DownloadPdf, FormStatus, signedLine } from "@/components/tax-form-bits";

const PATHS = { w4: "/tax-forms/w4", i9: "/tax-forms/i9", direct_deposit: "/tax-forms/direct-deposit" } as const;
const WHY = {
  w4: "How much federal income tax to withhold from your pay. Update it when your family or finances change.",
  i9: "Confirms your identity and that you can work in the U.S. Required within your first 3 days.",
  direct_deposit: "Where your paycheck is deposited.",
};

function AdminQueue() {
  const { data, reload } = useApi<any[]>("/tax-forms/pending");
  if (!data) return null;
  return (
    <div className="card">
      <h2>Waiting on you</h2>
      {data.length ? (
        <table><tbody>{data.map((f) => (
          <tr key={f.id}>
            <td>
              <Link href={`/people/${f.employee.id}`}>{f.employee.name}</Link>
              <div className="muted">{f.label} · {f.summary} · {signedLine(f)}</div>
            </td>
            <td className="row" style={{ textAlign: "right" }}>
              {f.type === "i9" ? (
                <Link className="btn sm primary" href={`/tax-forms/${f.id}`}>Complete Section 2</Link>
              ) : (
                <>
                  <Link className="btn sm" href={`/tax-forms/${f.id}`}>View</Link>
                  <DownloadPdf form={f} />
                  <button className="btn sm primary" onClick={() => api(`/tax-forms/${f.id}/processed`, { method: "POST" }).then(reload)}>Mark entered in payroll</button>
                </>
              )}
            </td>
          </tr>
        ))}</tbody></table>
      ) : <Empty>Nothing to enter. New and updated W-4s and direct deposit forms appear here.</Empty>}
    </div>
  );
}

export default function TaxForms() {
  const { can } = useAuth();
  const settings = useApi("/tax-forms/settings");
  const mine = useApi<any[]>("/tax-forms/mine");
  if (!settings.data) return null;

  return (
    <>
      <PageHead title="Pay & tax forms" sub="Your W-4, I-9 and direct deposit. Social Security and bank numbers are encrypted; only you and payroll admins can see them." />
      {!settings.data.enabled ? (
        <div className="card"><p style={{ margin: 0 }}>Your company&apos;s payroll provider collects these forms. Watch for an email from them, or ask HR.</p></div>
      ) : (
        <div className="grid cols-2">
          {TAX_FORM_TYPES.map((type) => {
            const current = mine.data?.find((f) => f.type === type && !f.supersededAt);
            const older = mine.data?.filter((f) => f.type === type && f.supersededAt) ?? [];
            const i9Locked = type === "i9" && current?.status === "completed";
            return (
              <div className="card stack" key={type}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h2 style={{ margin: 0 }}>{TAX_FORM_LABELS[type]}</h2>
                  {current && <FormStatus form={current} />}
                </div>
                <p className="muted" style={{ margin: 0 }}>{WHY[type]}</p>
                {current ? (
                  <div className="muted">{current.summary} · {signedLine(current)}{type === "i9" && (current.status === "completed" ? " · verified" : " · waiting for HR to check your documents")}</div>
                ) : <div><strong>Not filled out yet.</strong></div>}
                <div className="row">
                  {!i9Locked && <Link className={`btn ${current ? "" : "primary"}`} href={PATHS[type]}>{current ? "Update" : "Fill out"}</Link>}
                  {current && <Link className="btn" href={`/tax-forms/${current.id}`}>View</Link>}
                  {current && <DownloadPdf form={current} />}
                </div>
                {older.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{older.length} earlier version{older.length > 1 ? "s" : ""} on file (last {fmtDate(older[0].signedAt)}).</div>}
              </div>
            );
          })}
        </div>
      )}
      {can("admin") && settings.data.enabled && <AdminQueue />}
    </>
  );
}
