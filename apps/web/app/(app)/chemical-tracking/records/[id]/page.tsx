"use client";
import Link from "next/link";
import { use, useState } from "react";
import { NOTICE_CHANNEL_LABELS, NOTICE_STATUS_LABELS, ODAFF_RULE, WEATHER_SOURCE_LABELS, type NoticeChannel, formatRateAmount, windText, type WeatherSource } from "@crewdesk/shared";
import { API_URL, api, fmtDate, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";

interface RecProduct {
  id: string; tradeName: string; epaRegNo: string | null; productType: string | null; restrictedUse: boolean; rateName: string | null; ratePer1000: number; unit: string;
  dilutionPerGal: number | null; carrierGalPer1000: number | null; methodName: string | null; mixName?: string | null; amount: number; targets: string | null; reiHours: number | null; label: { id: string; fileName: string } | null;
}
interface Rec {
  id: string; visitId: string | null; visitNumber: number | null; companyName: string; companyAddress: string | null; companyLicenseNo: string | null;
  applicatorName: string; applicatorCertNo: string | null; applicatorCertExpires: string | null; customerName: string; customerAddress: string | null;
  siteAddress: string | null; appliedOn: string; startedAt: string | null; stoppedAt: string | null; site: string | null; areaSqFt: number | null; tankMixGal: number | null;
  lat: number | null; lng: number | null; issues: string[]; voidedAt: string | null; voidReason: string | null; createdAt: string;
  products: RecProduct[];
  weather: { source: string | null; windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null; rainIn: number | null; station: string | null; observedAt: string | null } | null;
  changes: { id: string; field: string; oldValue: string | null; newValue: string | null; reason: string; by: string | null; createdAt: string }[];
}

const n = (v: number | null | undefined, d = 3) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d }));
const time = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");
const localInput = (d: string | null) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");

/** One chemical application record, laid out by the rule's items, printable for an inspection. */
export default function ChemicalRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const data = useApi<Rec>(`/chemical-records/${id}`);
  const [fixing, setFixing] = useState(false);
  const r = data.data;
  if (data.error) return <><PageHead title="Chemical record" /><ErrorBox error={data.error} /></>;
  if (!r) return <PageHead title="Chemical record" sub="Loading…" />;
  const item = (num: string, label: string, value: React.ReactNode) => <><dt><span className="muted">{num}</span> {label}</dt><dd>{value || <span className="badge warn">missing</span>}</dd></>;
  return (
    <>
      <PageHead title={`Chemical application record · ${fmtDate(r.appliedOn)}`} sub={`${ODAFF_RULE} (Oklahoma Department of Agriculture). Item numbers follow the rule.`}>
        <button className="btn noprint" onClick={() => window.print()}>Print</button>
        {!r.voidedAt && <button className="btn noprint" onClick={() => setFixing(!fixing)}>Correct</button>}
      </PageHead>
      {r.voidedAt && <div className="card" style={{ marginBottom: 12 }}><span className="badge">voided</span> {fmtDateTime(r.voidedAt)}: {r.voidReason}. Kept for the record; a new record was made if the work order was completed again.</div>}
      {r.issues.length > 0 && !r.voidedAt && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Needs attention</strong>
          <ul style={{ margin: "6px 0 0" }}>{r.issues.map((x) => <li key={x}>Item {x}</li>)}</ul>
        </div>
      )}
      {fixing && <CorrectionForm r={r} onDone={() => { setFixing(false); data.reload(); }} />}
      <div className="card stack">
        <dl className="facts">
          {item("3", "Company", <>{r.companyName}{r.companyAddress && <div className="muted">{r.companyAddress}</div>}{r.companyLicenseNo && <div className="muted">License # {r.companyLicenseNo}</div>}</>)}
          {item("4", "Certified applicator", r.applicatorCertNo ? <>{r.applicatorName}<div className="muted">Certification # {r.applicatorCertNo} · expires {fmtDate(r.applicatorCertExpires)}</div></> : null)}
          {item("5", "Applied for", <>{r.customerName}{r.customerAddress && <div className="muted">{r.customerAddress}</div>}</>)}
          {item("6", "Where (legal description)", r.siteAddress)}
          {item("7", "Date", fmtDate(r.appliedOn))}
          {item("1", "Start and stop", r.startedAt && r.stoppedAt ? `${time(r.startedAt)} – ${time(r.stoppedAt)}` : null)}
          {item("16", "Site", r.site)}
          {item("17", "Area treated", r.areaSqFt != null ? `${n(r.areaSqFt, 0)} sq ft` : null)}
          {item("10", "Tank mix used", r.tankMixGal != null ? `${n(r.tankMixGal, 1)} gal` : "Not mixed (applied dry)")}
          {item("22", "Weather", r.weather?.source ? <>{windText(r.weather)}{r.weather.tempF != null ? ` · ${r.weather.tempF}°F` : ""}{r.weather.rainIn != null ? ` · ${r.weather.rainIn}" rain (24 h)` : ""}<div className="muted">{WEATHER_SOURCE_LABELS[r.weather.source as WeatherSource] ?? r.weather.source}{r.weather.station ? ` · ${r.weather.station}` : ""}</div></> : <span className="muted">Pending (Field → Weather)</span>)}
          {r.lat != null && <><dt>Location at completion</dt><dd>{r.lat.toFixed(5)}, {r.lng?.toFixed(5)}</dd></>}
          {r.visitId && <><dt>Work order</dt><dd className="noprint"><Link href={`/visits/${r.visitId}`}>WO-{r.visitNumber}</Link></dd></>}
        </dl>
      </div>
      <div className="card tablewrap" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Products</h3>
        <table>
          <thead><tr><th>11 Trade name / 12 EPA #</th><th>8 Rate per 1,000 sq ft</th><th>9 Dilution</th><th>2 Amount used</th><th>15 Target</th><th>18 REI</th><th>19 Label</th></tr></thead>
          <tbody>{r.products.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.tradeName}</strong>{p.restrictedUse && <> <span className="badge bad">RUP</span></>}{p.productType === "adjuvant" && <> <span className="badge">adjuvant</span></>}<div className="muted">{p.epaRegNo ? `EPA ${p.epaRegNo}` : p.productType === "adjuvant" ? "" : "no EPA #"}</div></td>
              <td>{formatRateAmount(p.ratePer1000, p.unit)}{p.rateName ? <div className="muted">{p.rateName}</div> : null}</td>
              <td>{p.dilutionPerGal != null ? `${formatRateAmount(p.dilutionPerGal, p.unit)} per gal` : "Not mixed"}{p.methodName || p.carrierGalPer1000 ? <div className="muted">{[p.mixName ? `Mix: ${p.mixName}` : null, p.methodName, p.carrierGalPer1000 ? `${n(p.carrierGalPer1000)} gal spray / 1,000` : null].filter(Boolean).join(" · ")}</div> : null}</td>
              <td>{formatRateAmount(p.amount, p.unit)}</td>
              <td>{p.targets ?? "—"}</td>
              <td>{p.reiHours != null ? `${n(p.reiHours, 1)} h` : "—"}</td>
              <td>{p.label ? <a href={`${API_URL}/chemical-records/label-files/${p.label.id}`} target="_blank" rel="noreferrer">{p.label.fileName}</a> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>Items 13–14 (adjuvants and drift agents the label requires) are listed with the products. Items 20–21 apply to structural work only.</p>
      </div>
      {r.changes.length > 0 && (
        <div className="card tablewrap" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Corrections</h3>
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th><th>Why</th></tr></thead>
            <tbody>{r.changes.map((c) => (
              <tr key={c.id}><td>{fmtDateTime(c.createdAt)}</td><td>{c.by ?? "—"}</td><td>{c.field}</td><td>{c.oldValue ?? "—"}</td><td>{c.newValue ?? "—"}</td><td>{c.reason}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <RecordNotices recordId={r.id} />
      <p className="muted">Record made {fmtDateTime(r.createdAt)}. Records are kept and never deleted.</p>
    </>
  );
}

/** The customer's notice for this application: what went out, and sending or printing one now. */
function RecordNotices({ recordId }: { recordId: string }) {
  const list = useApi<{ id: string; channel: string; status: string; to: string | null; detail: string | null; sentAt: string | null; createdAt: string }[]>(`/chemical-tracking/notices?recordId=${recordId}`);
  const act = useAction();
  const send = (channel: "email" | "text") => act.run(async () => { await api(`/chemical-tracking/records/${recordId}/notice`, { method: "POST", body: { channel } }); list.reload(); });
  const rows = list.data ?? [];
  return (
    <div className="card stack noprint" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Customer notice</h3>
        <div className="row">
          <button className="btn" disabled={act.busy} onClick={() => send("email")}>Email it</button>
          <button className="btn" disabled={act.busy} onClick={() => send("text")}>Text it</button>
          <Link className="btn" href={`/chemical-tracking/notices/print?record=${recordId}`}>Print it</Link>
        </div>
      </div>
      {rows.length ? (
        <ul className="plain-list">{rows.map((n) => (
          <li key={n.id}>{NOTICE_CHANNEL_LABELS[n.channel as NoticeChannel] ?? n.channel}{n.to ? ` to ${n.to}` : ""}: <strong>{NOTICE_STATUS_LABELS[n.status] ?? n.status}</strong> <span className="muted">{fmtDateTime(n.sentAt ?? n.createdAt)}{n.detail ? ` · ${n.detail}` : ""}</span></li>
        ))}</ul>
      ) : <p className="muted" style={{ margin: 0 }}>No notice for this application yet.</p>}
      <ErrorBox error={list.error ?? act.error} />
    </div>
  );
}

function CorrectionForm({ r, onDone }: { r: Rec; onDone: () => void }) {
  const [f, setF] = useState({ reason: "", startedAt: localInput(r.startedAt), stoppedAt: localInput(r.stoppedAt), site: r.site ?? "", areaSqFt: r.areaSqFt != null ? String(Math.round(r.areaSqFt)) : "", tankMixGal: r.tankMixGal != null ? String(Math.round(r.tankMixGal * 10) / 10) : "" });
  const [ps, setPs] = useState(r.products.map((p) => ({ id: p.id, name: p.tradeName, unit: p.unit, amount: String(Math.round(p.amount * 1000) / 1000), targets: p.targets ?? "" })));
  const act = useAction();
  const save = () => act.run(async () => {
    const iso = (v: string) => (v ? new Date(v).toISOString() : null);
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const body: Record<string, unknown> = { reason: f.reason };
    if (f.startedAt !== localInput(r.startedAt)) body.startedAt = iso(f.startedAt);
    if (f.stoppedAt !== localInput(r.stoppedAt)) body.stoppedAt = iso(f.stoppedAt);
    if (f.site !== (r.site ?? "")) body.site = f.site;
    if (f.areaSqFt !== (r.areaSqFt != null ? String(Math.round(r.areaSqFt)) : "")) body.areaSqFt = num(f.areaSqFt);
    if (f.tankMixGal !== (r.tankMixGal != null ? String(Math.round(r.tankMixGal * 10) / 10) : "")) body.tankMixGal = num(f.tankMixGal);
    body.products = ps.map((p, i) => {
      const was = r.products[i];
      return { id: p.id, ...(p.amount !== String(Math.round(was.amount * 1000) / 1000) ? { amount: Number(p.amount) } : {}), ...(p.targets !== (was.targets ?? "") ? { targets: p.targets } : {}) };
    });
    await api(`/chemical-records/${r.id}`, { method: "PATCH", body });
    onDone();
  });
  return (
    <div className="card stack noprint" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>Correct this record</h3>
      <p className="muted" style={{ margin: 0 }}>Every change is kept with who made it, when and why.</p>
      <div className="formgrid">
        <label>Start<input type="datetime-local" value={f.startedAt} onChange={(e) => setF({ ...f, startedAt: e.target.value })} /></label>
        <label>Stop<input type="datetime-local" value={f.stoppedAt} onChange={(e) => setF({ ...f, stoppedAt: e.target.value })} /></label>
        <label>Site<input value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></label>
        <label>Area treated (sq ft)<input inputMode="numeric" value={f.areaSqFt} onChange={(e) => setF({ ...f, areaSqFt: e.target.value })} /></label>
        <label>Tank mix used (gal)<input inputMode="decimal" value={f.tankMixGal} onChange={(e) => setF({ ...f, tankMixGal: e.target.value })} /></label>
      </div>
      {ps.map((p, i) => (
        <div key={p.id} className="row">
          <strong style={{ alignSelf: "flex-end", minWidth: 200 }}>{p.name}</strong>
          <label style={{ width: 160 }}>Amount used ({formatRateAmount(1, p.unit).replace(/^1 /, "")})<input inputMode="decimal" value={p.amount} onChange={(e) => setPs(ps.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></label>
          <label style={{ flex: 1 }}>Target pest<input value={p.targets} onChange={(e) => setPs(ps.map((x, j) => (j === i ? { ...x, targets: e.target.value } : x)))} /></label>
        </div>
      ))}
      <label>Why it's being corrected<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required placeholder="e.g. Back lawn skipped, gate locked" /></label>
      <ErrorBox error={act.error} />
      <div className="row"><button className="btn primary" disabled={act.busy || f.reason.trim().length < 3} onClick={save}>Save correction</button></div>
    </div>
  );
}
