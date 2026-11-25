"use client";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";

interface Applicator { id: string; name: string; certNo: string | null; expiresOn: string | null; categories: string | null }

/** A local date n days back (not UTC, so evenings stay on today). */
const daysAgo = (n: number) => { const d = new Date(Date.now() - n * 86_400_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };

/** What every record draws on: the company license number and each applicator's certification. */
export default function Applicators() {
  const admin = true;
  const settings = useApi<{ pesticideLicenseNo: string | null }>("/chemical-records/settings");
  const people = useApi<Applicator[]>("/chemical-records/applicators");
  const [license, setLicense] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [cert, setCert] = useState({ certNo: "", expiresOn: "", categories: "" });
  const act = useAction();
  const today = daysAgo(0);
  const soon = daysAgo(-60);
  const saveLicense = () => act.run(async () => { await api("/chemical-records/settings", { method: "PUT", body: { pesticideLicenseNo: license ?? "" } }); setLicense(null); settings.reload(); });
  const saveCert = (id: string) => act.run(async () => { await api(`/chemical-records/applicators/${id}`, { method: "PUT", body: cert }); setEditing(null); people.reload(); });
  const removeCert = (id: string) => act.run(async () => { await api(`/chemical-records/applicators/${id}`, { method: "DELETE" }); people.reload(); });
  return (
    <>
    <PageHead title="Applicators & license" sub="Every record carries the company license number and the applicator's certification." />
    <div className="card stack">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ width: 260 }}>Company pesticide license #
          <input value={license ?? settings.data?.pesticideLicenseNo ?? ""} disabled={!admin} onChange={(e) => setLicense(e.target.value)} />
        </label>
        {admin && license !== null && <button className="btn primary" disabled={act.busy} onClick={saveLicense}>Save</button>}
      </div>
      <h4 style={{ margin: "8px 0 0" }}>Certified applicators <span className="muted">(name, certification # and expiration go on every record they make)</span></h4>
      <ErrorBox error={act.error} />
      <div className="tablewrap">
        <table>
          <thead><tr><th>Employee</th><th>Certification #</th><th>Expires</th><th>Categories</th>{admin && <th />}</tr></thead>
          <tbody>{(people.data ?? []).map((p) => editing === p.id ? (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td><input aria-label="Certification number" value={cert.certNo} onChange={(e) => setCert({ ...cert, certNo: e.target.value })} /></td>
              <td><input aria-label="Expires" type="date" value={cert.expiresOn} onChange={(e) => setCert({ ...cert, expiresOn: e.target.value })} /></td>
              <td><input aria-label="Categories" value={cert.categories} onChange={(e) => setCert({ ...cert, categories: e.target.value })} placeholder="e.g. 3A, 7A" /></td>
              <td className="row"><button className="btn primary" disabled={act.busy} onClick={() => saveCert(p.id)}>Save</button><button className="btn" onClick={() => setEditing(null)}>Cancel</button></td>
            </tr>
          ) : (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.certNo ?? <span className="muted">none</span>}</td>
              <td>{p.expiresOn ? <>{fmtDate(p.expiresOn)} {p.expiresOn < today ? <span className="badge bad">expired</span> : p.expiresOn <= soon ? <span className="badge warn">expires soon</span> : null}</> : ""}</td>
              <td>{p.categories ?? ""}</td>
              {admin && <td className="row">
                <button className="btn" onClick={() => { setEditing(p.id); setCert({ certNo: p.certNo ?? "", expiresOn: p.expiresOn ?? "", categories: p.categories ?? "" }); }}>{p.certNo ? "Edit" : "Add"}</button>
                {p.certNo && <button className="btn" disabled={act.busy} onClick={() => confirm(`Remove ${p.name}'s certification?`) && removeCert(p.id)}>Remove</button>}
              </td>}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
    </>
  );
}
