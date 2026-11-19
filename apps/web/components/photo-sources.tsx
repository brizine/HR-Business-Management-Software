"use client";
import { useState } from "react";
import type { ImagerySource, ImagerySourceInput } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "./ui";
import { AddressCounties } from "./address-counties";

export interface ImageryList {
  sources: ImagerySource[];
  checkedAt: string;
  error: string | null;
  canManage: boolean;
  custom: ImagerySourceInput[];
}

const EMPTY = { label: "", detail: "", kind: "wms" as "wms" | "tiles", url: "", layers: "", attribution: "", leafOff: true };

/**
 * Admins (Measure page): how the Oklahoma photos stay current (found automatically on OKMaps, re-checked
 * at most twice a day when the page is used, or now), and the company's own photo sources for anything else.
 */
export function PhotoSources({ list, onChange }: { list: ImageryList; onChange: (next: ImageryList) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const check = useAction();
  const save = useAction();
  const found = list.sources.filter((s) => s.origin === "okmaps");

  const saveCustom = (custom: ImagerySourceInput[]) =>
    save.run(async () => {
      const result = await api("/measurements/imagery/custom", { method: "PUT", body: { custom } });
      onChange({ ...list, ...result, custom });
    });

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const key = `custom-${Date.now().toString(36)}`;
    const source: ImagerySourceInput = {
      key, kind: form.kind, label: form.label, detail: form.detail, url: form.url,
      layers: form.kind === "wms" ? form.layers : null, attribution: form.attribution || null, leafOff: form.leafOff, maxNativeZoom: null,
    };
    saveCustom([...list.custom, source]).then((ok) => { if (ok) { setForm(EMPTY); setAdding(false); } });
  };

  return (
    <details className="photo-sources">
      <summary>Photo and address sources (admins)</summary>
      <div className="stack" style={{ gap: 10, marginTop: 8 }}>
        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: 14 }}>Oklahoma photos: updated automatically</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            When the Measure page is opened, Crewdesk checks the State of Oklahoma&apos;s map server (OKMaps) for newly released
            statewide photos (at most twice a day).
            A new leaf-off year is added to the list (marked New for 60 days) and becomes the default; the newest summer
            NAIP photo replaces the older one. Last checked {fmtDateTime(list.checkedAt)}.
          </span>
          <span style={{ fontSize: 13 }}>Found now: {found.map((s) => s.label).join(", ") || "none"}</span>
          {list.error && <span className="error" style={{ fontSize: 13 }}>{list.error}</span>}
          <div>
            <button className="btn sm" disabled={check.busy} onClick={() => check.run(async () => onChange(await api("/measurements/imagery?refresh=1")))}>
              {check.busy ? "Checking OKMaps…" : "Check for New Photos Now"}
            </button>
          </div>
          <ErrorBox error={check.error} />
          <span className="muted" style={{ fontSize: 12 }}>Esri&apos;s photos need nothing: the newest ones appear under &ldquo;Find more photo dates here&rdquo; as soon as Esri publishes them.</span>
        </div>

        <div className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <strong style={{ fontSize: 14 }}>Your own photo sources</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            For photos the automatic check doesn&apos;t pick up: a county&apos;s aerials, a paid service you subscribe to, or a new
            Oklahoma release named differently. Everyone sees these in the photo list.
          </span>
          {!list.custom.length && <span className="muted" style={{ fontSize: 13 }}>None added.</span>}
          {list.custom.map((c) => (
            <div key={c.key} className="row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ fontSize: 14 }}><strong>{c.label}</strong> <span className="muted">{c.detail} · {c.kind === "wms" ? `WMS layer ${c.layers}` : "tiles"}</span></span>
              <button className="btn sm danger" disabled={save.busy} onClick={() => window.confirm(`Remove “${c.label}”?`) && saveCustom(list.custom.filter((x) => x.key !== c.key))}>Remove</button>
            </div>
          ))}
          {!adding ? (
            <div><button className="btn sm" onClick={() => setAdding(true)}>Add a Photo Source</button></div>
          ) : (
            <form className="stack" style={{ gap: 8 }} onSubmit={add}>
              <div className="formgrid">
                <label>Name<input required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Oklahoma 2027 leaf-off" maxLength={80} /></label>
                <label>Date and details<input value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="e.g. Feb 2027 · 6-inch" maxLength={120} /></label>
                <label>Type
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "wms" | "tiles" })}>
                    <option value="wms">WMS server (state and county GIS)</option>
                    <option value="tiles">Tile address with {"{z}/{x}/{y}"}</option>
                  </select>
                </label>
                <label>{form.kind === "wms" ? "WMS address" : "Tile address"}
                  <input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={form.kind === "wms" ? "https://okmaps.org/geoserver/ogi/wms" : "https://example.com/tiles/{z}/{x}/{y}.jpg"} maxLength={500} />
                </label>
                {form.kind === "wms" && (
                  <label>Layer name<input required value={form.layers} onChange={(e) => setForm({ ...form, layers: e.target.value })} placeholder="e.g. ogi:Aerial2027_Composite" maxLength={200} /></label>
                )}
                <label>Credit shown on the map<input value={form.attribution} onChange={(e) => setForm({ ...form, attribution: e.target.value })} placeholder="e.g. Cleveland County GIS" maxLength={300} /></label>
              </div>
              <label className="row" style={{ gap: 6, fontWeight: "normal" }}>
                <input type="checkbox" checked={form.leafOff} onChange={(e) => setForm({ ...form, leafOff: e.target.checked })} style={{ width: "auto" }} />
                Taken with the leaves off (winter)
              </label>
              <ErrorBox error={save.error} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" disabled={save.busy}>Add</button>
                <button type="button" className="btn sm" onClick={() => { setAdding(false); setForm(EMPTY); }}>Cancel</button>
              </div>
            </form>
          )}
        </div>
        <AddressCounties />
      </div>
    </details>
  );
}
