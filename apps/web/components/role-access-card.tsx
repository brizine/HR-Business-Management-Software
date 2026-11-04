"use client";
import { useEffect, useState } from "react";
import { CONFIGURABLE_ROLES, ROLES, hasRole, roleDefaultLevel, type ConfigurableRole, type PermissionArea, type Role, type RoleAccess } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { useMenuData } from "@/lib/menus";
import { ErrorBox } from "@/components/ui";

type Area = { key: PermissionArea; label: string; max?: Role; levels: Partial<Record<Role, string>> };
const LEVEL_NAMES: Record<Role, string> = { employee: "Basic", manager: "Manager", admin: "Admin", owner: "Owner" };

/** What a level allows in an area: its own description, or the nearest lower one. */
function describe(area: Area, level: Role) {
  for (const r of [...ROLES].filter((r) => hasRole(level, r))) if (area.levels[r]) return area.levels[r]!;
  return "Only what everyone can do";
}
/** Basic plus each level that adds something in the area, up to its maximum. */
const levelsFor = (area: Area): Role[] => (["employee", "manager", "admin", "owner"] as Role[]).filter((r) => (r === "employee" || area.levels[r]) && hasRole(area.max ?? "owner", r));
/** The choice that matches a level: the highest offered level it reaches (e.g. Admin in Schedule acts as Manager). */
const shownLevel = (area: Area, level: Role): Role => levelsFor(area).filter((l) => hasRole(level, l)).pop() ?? "employee";

/**
 * Settings → Layout Editor: what each role can do in each area of the software. Everyone with the
 * role gets it; the Permissions page can still give one person something different.
 */
export function RoleAccessCard() {
  const { signIn } = useAuth();
  const { label } = useMenuData();
  const data = useApi<{ areas: Area[]; roleAccess: RoleAccess }>("/permissions");
  const [draft, setDraft] = useState<RoleAccess>({});
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (data.data) setDraft(data.data.roleAccess); }, [data.data]);
  if (!data.data) return <div className="card"><h2>Role access</h2><ErrorBox error={data.error} /></div>;
  const { areas, roleAccess } = data.data;
  const roleName = (r: Role) => { const l = label("role", r); return l[0].toUpperCase() + l.slice(1); };
  const level = (src: RoleAccess, r: ConfigurableRole, a: Area) => shownLevel(a, roleDefaultLevel(r, src, a.key));
  const defaultLevel = (r: ConfigurableRole, a: Area) => shownLevel(a, roleDefaultLevel(r, {}, a.key));
  const changed = CONFIGURABLE_ROLES.some((r) => areas.some((a) => level(draft, r, a) !== level(roleAccess, r, a)));
  const custom = CONFIGURABLE_ROLES.some((r) => Object.keys(draft[r] ?? {}).length > 0);
  const set = (r: ConfigurableRole, a: Area, value: Role) => {
    const next = { ...(draft[r] ?? {}) };
    if (value === defaultLevel(r, a)) delete next[a.key]; else next[a.key] = value;
    setDraft({ ...draft, [r]: next });
    setSaved(false);
  };
  const save = () => run(async () => {
    let result = data.data!;
    for (const r of CONFIGURABLE_ROLES) {
      if (!areas.some((a) => level(draft, r, a) !== level(roleAccess, r, a))) continue;
      result = await api(`/permissions/roles/${r}`, { method: "PUT", body: { areas: draft[r] ?? {} } });
    }
    data.setData({ ...data.data!, roleAccess: result.roleAccess });
    setSaved(true);
    await signIn(); // in case your own menus change
  });

  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Role access</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          What each role can do in each area of the software. Everyone with that role gets it right away, on the website and the mobile app.
          {" "}Owners always have full access. To give one person something different, use <a href="/settings/permissions">Permissions</a>.
        </p>
      </div>
      <div className="tablewrap">
        <table className="perm-table role-access-table">
          <thead>
            <tr><th>Area</th>{CONFIGURABLE_ROLES.map((r) => <th key={r}>{roleName(r)}</th>)}<th>{roleName("owner")}</th></tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr key={a.key}>
                <th scope="row">{a.label}</th>
                {CONFIGURABLE_ROLES.map((r) => {
                  const value = level(draft, r, a);
                  const isDefault = value === defaultLevel(r, a);
                  return (
                    <td key={r} className={isDefault ? undefined : "perm-custom"}>
                      <select value={value} style={{ minWidth: 150 }} onChange={(e) => set(r, a, e.target.value as Role)} aria-label={`${a.label} access for ${roleName(r)}`}>
                        {levelsFor(a).map((l) => <option key={l} value={l}>{LEVEL_NAMES[l]}{l === defaultLevel(r, a) ? " (default)" : ""}</option>)}
                      </select>
                      <div className="muted" style={{ fontSize: 12 }}>{describe(a, value)}</div>
                    </td>
                  );
                })}
                <td className="muted">Full access</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !changed} onClick={save}>Save role access</button>
        {changed && <button className="btn" onClick={() => { setDraft(roleAccess); }}>Undo changes</button>}
        {custom && !changed && <button className="btn" disabled={busy} onClick={() => confirm("Put every role back to its default access?") && setDraft({})}>Reset to defaults</button>}
        {saved && !changed && <span className="muted" role="status">Saved. It takes effect right away.</span>}
      </div>
    </div>
  );
}
