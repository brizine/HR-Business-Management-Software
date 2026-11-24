"use client";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Person { id: string; name: string; role: string; admin: boolean; listed: boolean; access: boolean }

/** Who can open Chemical Tracking: admins always, plus the people an admin adds here. */
export default function Access() {
  const data = useApi<{ canManage: boolean; people: Person[] }>("/chemical-tracking/access");
  const act = useAction();
  const manage = !!data.data?.canManage;
  const set = (p: Person, on: boolean) => act.run(async () => { await api(`/chemical-tracking/access/${p.id}`, { method: on ? "PUT" : "DELETE" }); data.reload(); });
  const people = data.data?.people ?? [];
  const withAccess = people.filter((p) => p.access);
  const others = people.filter((p) => !p.access);
  return (
    <>
      <PageHead title="Access"
        sub="Chemical Tracking holds the product rates, costs and state records, so only admins and the people added here can open it. Everyone else, managers included, can't." />
      <ErrorBox error={data.error ?? act.error} />
      <div className="card tablewrap">
        <h3 style={{ margin: "0 0 8px" }}>Can open Chemical Tracking</h3>
        {withAccess.length ? (
          <table>
            <tbody>{withAccess.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong> <span className="muted">{p.role}</span></td>
                <td>{p.admin ? <span className="badge">admin: always</span> : <span className="badge ok">added</span>}</td>
                <td>{manage && !p.admin && <button className="btn" disabled={act.busy} onClick={() => set(p, false)}>Remove</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>{data.loading ? "Loading…" : "Nobody yet."}</Empty>}
      </div>
      {manage ? (
        <div className="card tablewrap" style={{ marginTop: 16 }}>
          <h3 style={{ margin: "0 0 8px" }}>Add someone</h3>
          {others.length ? (
            <table>
              <tbody>{others.map((p) => (
                <tr key={p.id}>
                  <td>{p.name} <span className="muted">{p.role}</span></td>
                  <td><button className="btn" disabled={act.busy} onClick={() => set(p, true)}>Give access</button></td>
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>Everyone active already has access.</Empty>}
        </div>
      ) : <p className="muted">Only admins change who has access.</p>}
    </>
  );
}
