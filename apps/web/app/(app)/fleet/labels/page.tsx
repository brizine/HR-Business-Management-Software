"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { AssetLabel } from "@/components/qr";
import { Empty, PageHead } from "@/components/ui";

/** Print sheet of QR labels. Prints on plain paper or adhesive label sheets. */
function Labels() {
  const { me } = useAuth();
  const ids = useSearchParams().get("ids")?.split(",");
  const { data } = useApi<any[]>("/assets");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [size, setSize] = useState<"small" | "large">("large");

  useEffect(() => {
    if (data) setSelected(new Set(data.filter((a) => (ids ? ids.includes(a.id) : a.status !== "retired")).map((a) => a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const chosen = (data ?? []).filter((a) => selected.has(a.id));

  return (
    <>
      <div className="noprint">
        <PageHead title="QR labels" sub="Stick one on each vehicle or piece of equipment. Anyone can scan it with a phone camera.">
          <select value={size} onChange={(e) => setSize(e.target.value as "small" | "large")} style={{ width: 170 }}>
            <option value="large">Large (4″ × 2″)</option>
            <option value="small">Small (2.6″ × 1″)</option>
          </select>
          <button className="btn primary" disabled={!chosen.length} onClick={() => window.print()}>Print {chosen.length} label{chosen.length === 1 ? "" : "s"}</button>
        </PageHead>
        <div className="card row">
          {data?.map((a) => (
            <label key={a.id} className="check" style={{ marginRight: 12 }}>
              <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} /> {a.name}
            </label>
          ))}
        </div>
        <p className="muted">Tip: use weatherproof vinyl labels for vehicles and outdoor equipment.</p>
      </div>
      {chosen.length ? (
        <div className={`labelsheet labelsheet-${size}`}>
          {chosen.map((a) => <AssetLabel key={a.id} asset={a} company={me?.company.name ?? ""} size={size} />)}
        </div>
      ) : <Empty>Select equipment to print labels for.</Empty>}
    </>
  );
}

export default function Page() {
  return <Suspense><Labels /></Suspense>;
}
