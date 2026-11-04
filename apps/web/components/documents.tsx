"use client";
import { useState } from "react";
import { api, download, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox } from "./ui";
import { MenuSelect, useMenus } from "./menu-select";


/** Upload, download, sign and delete documents for an employee, an asset, or company-wide. */
const NO_FILTERS = { q: "", category: "", belongs: "", signature: "", from: "", to: "" };

/** Search and filters for the Documents page. */
function DocumentFilters({ docs, filters, onChange, manager, categories }: { docs: any[]; filters: typeof NO_FILTERS; onChange: (f: typeof NO_FILTERS) => void; manager: boolean; categories: string[] }) {
  const set = (patch: Partial<typeof NO_FILTERS>) => onChange({ ...filters, ...patch });
  const people = [...new Map(docs.filter((d) => d.employeeId).map((d) => [d.employeeId, d.employeeName ?? "Unknown"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const cats = [...new Set([...categories, ...docs.map((d) => d.category).filter(Boolean)])];
  return (
    <form className="filters" role="search" aria-label="Filter documents" onSubmit={(e) => e.preventDefault()} style={{ marginBottom: 12 }}>
      <label>Search
        <input type="search" placeholder={manager ? "Name, category, person, asset…" : "Name, category…"} value={filters.q} onChange={(e) => set({ q: e.target.value })} />
      </label>
      <label>Category
        <select value={filters.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label>Belongs to
        <select value={filters.belongs} onChange={(e) => set({ belongs: e.target.value })}>
          <option value="">Everything</option>
          <option value="company">Company-wide</option>
          <option value="employee">{manager ? "Employee files" : "My file"}</option>
          <option value="asset">Assets</option>
          {manager && people.length > 0 && (
            <optgroup label="One person">
              {people.map(([id, name]) => <option key={id} value={`person:${id}`}>{name}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <label>Signature
        <select value={filters.signature} onChange={(e) => set({ signature: e.target.value })}>
          <option value="">Any</option>
          <option value="pending">Waiting to be signed</option>
          <option value="signed">Signed</option>
          <option value="none">No signature needed</option>
        </select>
      </label>
      <fieldset className="pay-range date-range">
        <legend>Added</legend>
        <input type="date" aria-label="Added on or after" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        <span className="muted">to</span>
        <input type="date" aria-label="Added on or before" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
      </fieldset>
      {Object.values(filters).some(Boolean) && <button type="button" className="btn" onClick={() => onChange(NO_FILTERS)}>Clear filters</button>}
    </form>
  );
}

const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function matches(d: any, f: typeof NO_FILTERS) {
  const q = f.q.trim().toLowerCase();
  if (q && !`${d.name} ${d.category ?? ""} ${d.employeeName ?? ""} ${d.assetName ?? ""} ${d.signedName ?? ""}`.toLowerCase().includes(q)) return false;
  if (f.category && d.category !== f.category) return false;
  if (f.belongs === "company" && (d.employeeId || d.assetId)) return false;
  if (f.belongs === "employee" && !d.employeeId) return false;
  if (f.belongs === "asset" && !d.assetId) return false;
  if (f.belongs.startsWith("person:") && d.employeeId !== f.belongs.slice(7)) return false;
  if (f.signature === "pending" && !(d.requiresSignature && !d.signedAt)) return false;
  if (f.signature === "signed" && !d.signedAt) return false;
  if (f.signature === "none" && d.requiresSignature) return false;
  const added = ymd(d.createdAt);
  if (f.from && added < f.from) return false;
  if (f.to && added > f.to) return false;
  return true;
}

export function DocumentList({ employeeId, assetId, title = "Documents", filterable = false }: { employeeId?: string; assetId?: string; title?: string; filterable?: boolean }) {
  const menus = useMenus();
  const { me, can } = useAuth();
  const qs = new URLSearchParams({ ...(employeeId ? { employeeId } : {}), ...(assetId ? { assetId } : {}) }).toString();
  const { data, reload } = useApi<any[]>(`/documents${qs ? `?${qs}` : ""}`);
  const [uploading, setUploading] = useState(false);
  const { busy, error, run } = useAction();
  const [filters, setFilters] = useState(NO_FILTERS);
  const filtering = filterable && Object.values(filters).some(Boolean);
  const rows = (data ?? []).filter((d) => !filtering || matches(d, filters));

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
            <MenuSelect name="category" label="Category" options={menus.documentCategories} blank={false} />
          </div>
          {can("manager", "documents") && employeeId && <label className="check"><input type="checkbox" name="requiresSignature" /> Employee must sign</label>}
          <ErrorBox error={error} />
          <div><button className="btn primary" disabled={busy}>Upload</button></div>
        </form>
      )}
      {filterable && !!data?.length && <DocumentFilters docs={data} filters={filters} onChange={setFilters} manager={can("manager", "documents")} categories={menus.documentCategories} />}
      {filtering && <p className="muted" role="status" style={{ marginTop: 0 }}>Showing {rows.length} of {data!.length} documents</p>}
      {rows.length ? (
        <div className="tablewrap"><table>
          <thead><tr><th>Name</th><th>Category</th><th>Added</th><th>Signature</th><th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{d.name}<div className="muted">{d.employeeId ? (filterable && d.employeeId !== me?.user.id ? d.employeeName ?? "" : "") : d.assetId ? (d.assetName ? `Asset: ${d.assetName}` : "Asset") : "Company-wide"}</div></td>
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
                  {can("manager", "documents") && <button className="btn sm danger" onClick={() => confirm(`Delete ${d.name}?`) && api(`/documents/${d.id}`, { method: "DELETE" }).then(reload)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : filtering ? <Empty>No documents match your filters.</Empty> : <Empty>No documents yet.</Empty>}
    </div>
  );
}
