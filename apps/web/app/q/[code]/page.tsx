"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_INSPECTION_ITEMS } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { Badge, ErrorBox } from "@/components/ui";

type Panel = "inspect" | "meter" | "issue" | null;

/**
 * Where a scanned QR label lands. Built for a phone held next to the truck:
 * big buttons for the three things people do at the equipment.
 */
export default function Scan({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { me, ready, can } = useAuth();
  const router = useRouter();
  const [asset, setAsset] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  const load = async () => {
    try {
      const { id } = await api(`/assets/by-code/${encodeURIComponent(code)}`);
      setAsset(await api(`/assets/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!ready) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(`/q/${code}`)}`);
    else load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me, code]);

  const finish = (message: string) => { setPanel(null); setDone(message); load(); };

  if (error) {
    return (
      <div className="scan">
        <h1>Label not recognized</h1>
        <p>{error}. The label may be from another company, or it was replaced with a new one.</p>
        <Link className="btn" href="/fleet">Browse equipment</Link>
      </div>
    );
  }
  if (!asset) return <div className="scan muted">Loading…</div>;

  const open = asset.workOrders.filter((w: any) => !["completed", "cancelled"].includes(w.status));
  const due = asset.schedules.filter((s: any) => s.due.status !== "ok");

  return (
    <div className="scan">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{asset.name}</h1>
          <div className="muted">{[asset.year, asset.make, asset.model, asset.licensePlate].filter(Boolean).join(" · ")}</div>
        </div>
        <Badge value={asset.status} />
      </div>
      {asset.status === "out_of_service" && <div className="error" style={{ marginTop: 10 }}>Out of service. Don&apos;t operate until the open work order is completed.</div>}
      {done && <div className="card" style={{ marginTop: 12 }}>✓ {done}</div>}

      <div className="scan-actions">
        <button className={`btn ${panel === "inspect" ? "primary" : ""}`} onClick={() => setPanel(panel === "inspect" ? null : "inspect")}>✓ Pre-trip inspection</button>
        <button className={`btn ${panel === "meter" ? "primary" : ""}`} onClick={() => setPanel(panel === "meter" ? null : "meter")}>⏲ Log odometer / hours</button>
        <button className={`btn ${panel === "issue" ? "primary" : ""}`} onClick={() => setPanel(panel === "issue" ? null : "issue")}>⚠ Report an issue</button>
      </div>

      {panel === "inspect" && (
        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
          action.run(async () => {
            const res = await api("/inspections", { body: {
              assetId: asset.id, odometer: num("odometer"), engineHours: num("engineHours"),
              items: DEFAULT_INSPECTION_ITEMS.map((item, i) => ({ item, ok: f.get(`ok-${i}`) !== "fail", note: (f.get(`note-${i}`) as string) || undefined })),
            } });
            finish(res.workOrder ? `Defects reported. Work order #${res.workOrder.number} opened for the shop.` : "Inspection passed. Have a safe trip.");
          });
        }}>
          <div className="formgrid">
            <label>Odometer<input name="odometer" type="number" inputMode="numeric" min="0" placeholder={String(asset.odometer)} /></label>
            <label>Engine hours<input name="engineHours" type="number" inputMode="decimal" min="0" step="0.1" placeholder={String(asset.engineHours)} /></label>
          </div>
          {DEFAULT_INSPECTION_ITEMS.map((item, i) => (
            <div key={item} className="scan-item">
              <strong>{item}</strong>
              <div className="row">
                <label className="check"><input type="radio" name={`ok-${i}`} value="ok" defaultChecked /> OK</label>
                <label className="check"><input type="radio" name={`ok-${i}`} value="fail" /> Defect</label>
                <input name={`note-${i}`} placeholder="Note" style={{ flex: 1, minWidth: 120 }} />
              </div>
            </div>
          ))}
          <ErrorBox error={action.error} />
          <button className="btn primary" disabled={action.busy}>Submit inspection</button>
        </form>
      )}

      {panel === "meter" && (
        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
          action.run(async () => {
            await api(`/assets/${asset.id}/meter`, { body: { odometer: num("odometer"), engineHours: num("engineHours") } });
            finish("Reading saved.");
          });
        }}>
          <div className="formgrid">
            <label>Odometer (now {asset.odometer.toLocaleString()})<input name="odometer" type="number" inputMode="numeric" min="0" /></label>
            <label>Engine hours (now {asset.engineHours.toLocaleString()})<input name="engineHours" type="number" inputMode="decimal" min="0" step="0.1" /></label>
          </div>
          <ErrorBox error={action.error} />
          <button className="btn primary" disabled={action.busy}>Save reading</button>
        </form>
      )}

      {panel === "issue" && (
        <form className="card stack" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          action.run(async () => {
            const wo = await api("/work-orders", { body: {
              assetId: asset.id, title: f.get("title"), description: (f.get("description") as string) || undefined, priority: f.get("priority"),
            } });
            finish(`Reported as work order #${wo.number}. The shop has been notified.`);
          });
        }}>
          <label>What&apos;s wrong?<input name="title" required placeholder="e.g. Check engine light on" /></label>
          <label>Details<textarea name="description" /></label>
          <label>How urgent?
            <select name="priority" defaultValue="medium">
              <option value="low">Low: can wait</option>
              <option value="medium">Medium: fix soon</option>
              <option value="high">High: affects work today</option>
              <option value="critical">Critical: unsafe, take out of service</option>
            </select>
          </label>
          <ErrorBox error={action.error} />
          <button className="btn primary" disabled={action.busy}>Send to shop</button>
        </form>
      )}

      {(open.length > 0 || due.length > 0) && (
        <div className="card">
          {open.length > 0 && <h2>Open work orders</h2>}
          {open.map((w: any) => (
            <div key={w.id} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>#{w.number} {w.title}</span><Badge value={w.status} />
            </div>
          ))}
          {due.length > 0 && <h2 style={{ marginTop: open.length ? 14 : 0 }}>Maintenance due</h2>}
          {due.map((s: any) => (
            <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{s.name}<span className="muted"> · {s.due.reasons.join(", ")}</span></span><Badge value={s.due.status} />
            </div>
          ))}
        </div>
      )}

      <div className="muted" style={{ marginTop: 12 }}>
        Last inspection: {asset.inspections[0] ? `${fmtDate(asset.inspections[0].createdAt)} (${asset.inspections[0].passed ? "passed" : "failed"})` : "never"}
        {can("manager") && <> · <Link href={`/fleet/${asset.id}`}>Full details</Link></>}
      </div>
    </div>
  );
}
