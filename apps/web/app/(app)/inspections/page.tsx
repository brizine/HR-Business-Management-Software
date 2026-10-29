"use client";
import { useState } from "react";
import { DEFAULT_INSPECTION_ITEMS } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

export default function Inspections() {
  const list = useApi<any[]>("/inspections");
  const assets = useApi<any[]>("/assets");
  const [doing, setDoing] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <>
      <PageHead title="Inspections" sub="Pre-trip and pre-use checks. Failed items open a work order automatically.">
        <button className="btn primary" onClick={() => setDoing(!doing)}>New inspection</button>
      </PageHead>
      {doing && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
            const body = {
              assetId: f.get("assetId"),
              odometer: num("odometer"),
              engineHours: num("engineHours"),
              notes: (f.get("notes") as string) || undefined,
              items: DEFAULT_INSPECTION_ITEMS.map((item, i) => ({ item, ok: f.get(`ok-${i}`) !== "fail", note: (f.get(`note-${i}`) as string) || undefined })),
            };
            run(async () => { await api("/inspections", { body }); setDoing(false); list.reload(); });
          }}>
            <div className="formgrid">
              <label>Asset<select name="assetId" required>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>Odometer<input name="odometer" type="number" min="0" /></label>
              <label>Engine hours<input name="engineHours" type="number" min="0" step="0.1" /></label>
            </div>
            <table><tbody>{DEFAULT_INSPECTION_ITEMS.map((item, i) => (
              <tr key={item}>
                <td>{item}</td>
                <td className="row">
                  <label className="check"><input type="radio" name={`ok-${i}`} value="ok" defaultChecked /> OK</label>
                  <label className="check"><input type="radio" name={`ok-${i}`} value="fail" /> Defect</label>
                </td>
                <td><input name={`note-${i}`} placeholder="Note" /></td>
              </tr>
            ))}</tbody></table>
            <label>Notes<textarea name="notes" /></label>
            <ErrorBox error={error} />
            <div><button className="btn primary" disabled={busy}>Submit inspection</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        {list.data?.length ? (
          <table>
            <thead><tr><th>When</th><th>Asset</th><th>Inspector</th><th>Result</th><th>Defects</th></tr></thead>
            <tbody>{list.data.map(({ inspection: i, assetName, inspector }) => (
              <tr key={i.id}>
                <td>{fmtDateTime(i.createdAt)}</td>
                <td>{assetName}</td>
                <td>{inspector?.firstName} {inspector?.lastName}</td>
                <td><Badge value={i.passed ? "passed" : "failed"} /></td>
                <td className="muted">{i.items.filter((x: any) => !x.ok).map((x: any) => x.item + (x.note ? ` (${x.note})` : "")).join(", ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No inspections yet.</Empty>}
      </div>
    </>
  );
}
