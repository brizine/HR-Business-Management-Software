"use client";
import { useState } from "react";
import { api, download, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox } from "./ui";

const CATEGORIES = ["general", "tax", "id", "policy", "certification", "contract", "registration", "insurance", "manual"];

/** Upload, download, sign and delete documents for an employee, an asset, or company-wide. */
export function DocumentList({ employeeId, assetId, title = "Documents" }: { employeeId?: string; assetId?: string; title?: string }) {
  const { me, can } = useAuth();
  const qs = new URLSearchParams({ ...(employeeId ? { employeeId } : {}), ...(assetId ? { assetId } : {}) }).toString();
  const { data, reload } = useApi<any[]>(`/documents${qs ? `?${qs}` : ""}`);
  const [uploading, setUploading] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button className="btn" onClick={() => setUploading(!uploading)}>Upload</button>
      </div>
      {uploading && (
        <form
          className="stack card"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            if (employeeId) fd.set("employeeId", employeeId);
            if (assetId) fd.set("assetId", assetId);
            fd.set("requiresSignature", String(fd.get("requiresSignature") === "on"));
            // Fastify multipart reads fields that come before the file.
            const file = fd.get("file");
            fd.delete("file");
            if (file) fd.append("file", file);
            run(async () => {
              await api("/documents", { body: fd });
              setUploading(false);
              reload();
            });
          }}
        >
          <div className="formgrid">
            <label>File<input name="file" type="file" required /></label>
            <label>Name<input name="name" placeholder="Defaults to file name" /></label>
            <label>Category<select name="category">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          {can("manager") && employeeId && <label className="check"><input type="checkbox" name="requiresSignature" /> Employee must sign</label>}
          <ErrorBox error={error} />
          <div><button className="btn primary" disabled={busy}>Upload</button></div>
        </form>
      )}
      {data?.length ? (
        <div className="tablewrap"><table>
          <thead><tr><th>Name</th><th>Category</th><th>Added</th><th>Signature</th><th /></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>{d.name}<div className="muted">{d.employeeId ? "" : d.assetId ? "Asset" : "Company-wide"}</div></td>
                <td>{d.category}</td>
                <td>{fmtDate(d.createdAt)}</td>
                <td>
                  {!d.requiresSignature ? "—" : d.signedAt ? <span><Badge value="completed" /> <span className="muted">{d.signedName}, {fmtDate(d.signedAt)}</span></span>
                    : d.employeeId === me?.user.id ? (
                      <button className="btn sm primary" onClick={() => {
                        const signedName = prompt("Type your full legal name to sign");
                        if (signedName) api(`/documents/${d.id}/sign`, { body: { signedName } }).then(reload, (e) => alert(e.message));
                      }}>Sign</button>
                    ) : <Badge value="pending" />}
                </td>
                <td className="row">
                  <button className="btn sm" onClick={() => download(`/documents/${d.id}/download`, d.name)}>Download</button>
                  {can("manager") && <button className="btn sm danger" onClick={() => confirm(`Delete ${d.name}?`) && api(`/documents/${d.id}`, { method: "DELETE" }).then(reload)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty>No documents yet.</Empty>}
    </div>
  );
}
