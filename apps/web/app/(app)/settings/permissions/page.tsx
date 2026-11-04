"use client";
import { useEffect, useState } from "react";
import { ROLES, hasRole, roleDefaultLevel, type PermissionArea, type Role, type RoleAccess } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";

type Area = { key: string; label: string; max?: Role; levels: Partial<Record<Role, string>> };
type Person = { id: string; firstName: string; lastName: string; role: Role; title: string | null; areas: Record<string, Role>; managesPermissions: boolean };

const NONE = "__none";
const NO_FILTERS = { q: "", role: "", title: "", access: "", area: "" };

const LEVEL_NAMES: Record<Role, string> = { employee: "Basic", manager: "Manager", admin: "Admin", owner: "Owner" };

/** What a level allows in an area: its own description, or the nearest lower one ("Basic" if none). */
function describe(area: Area, level: Role) {
  for (const r of [...ROLES].filter((r) => hasRole(level, r))) {
    if (area.levels[r]) return area.levels[r]!;
  }
  return "Only what everyone can do";
}

/** The levels worth offering in an area: Basic plus each level that adds something, up to its maximum. */
function levelsFor(area: Area): Role[] {
  const max = area.max ?? "owner";
  return (["employee", "manager", "admin", "owner"] as Role[]).filter((r) => (r === "employee" || area.levels[r]) && hasRole(max, r));
}

function PersonEditor({ person, areas, roleAccess, onSaved }: { person: Person; areas: Area[]; roleAccess: RoleAccess; onSaved: (p: Person) => void }) {
  const { me, can } = useAuth();
  const isOwner = can("owner");
  const self = person.id === me?.user.id;
  const locked = person.role === "owner" || self;
  const [draft, setDraft] = useState<Record<string, Role | "">>({});
  const [perms, setPerms] = useState(person.managesPermissions);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  // Reset only when switching to another person (saving updates `person` too).
  useEffect(() => { setDraft(Object.fromEntries(areas.map((a) => [a.key, person.areas[a.key] ?? ""]))); setPerms(person.managesPermissions); setSaved(false); }, [person.id, areas]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = areas.some((a) => (draft[a.key] ?? "") !== (person.areas[a.key] ?? "")) || perms !== person.managesPermissions;

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>{person.firstName} {person.lastName}</h2>
          <div className="muted">{LEVEL_NAMES[person.role]} by role{person.title ? ` · ${person.title}` : ""}</div>
        </div>
        {person.role === "owner" && <Badge value="active" />}
      </div>
      {person.role === "owner" ? (
        <p className="muted" style={{ margin: 0 }}>Owners always have full access to everything, including Permissions. This can&apos;t be changed.</p>
      ) : self ? (
        <p className="muted" style={{ margin: 0 }}>You can&apos;t change your own access. Ask the owner.</p>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Each area starts with what their role gives them. Pick a different level to give more (or less) access in that area.
        </p>
      )}
      <table className="perm-table">
        <thead><tr><th>Area</th><th>Access</th></tr></thead>
        <tbody>
          {areas.map((a) => {
            const value = draft[a.key] ?? "";
            // What their role gets here (Settings → Layout Editor → Role access), unless set for them.
            const roleLevel = roleDefaultLevel(person.role, roleAccess, a.key as PermissionArea);
            const effective = (value || roleLevel) as Role;
            const capped = hasRole(effective, a.max ?? "owner") ? (a.max ?? "owner") : effective;
            return (
              <tr key={a.key} className={value ? "perm-custom" : undefined}>
                <th scope="row">{a.label}</th>
                <td>
                  {locked ? (
                    <span>{person.role === "owner" ? "Full access" : `${LEVEL_NAMES[capped]}${value ? " (custom)" : ""}`}</span>
                  ) : (
                    <select value={value} onChange={(e) => { setDraft({ ...draft, [a.key]: e.target.value as Role | "" }); setSaved(false); }} aria-label={`${a.label} access for ${person.firstName}`}>
                      <option value="">Same as their role ({LEVEL_NAMES[roleLevel]})</option>
                      {levelsFor(a).map((r) => (
                        <option key={r} value={r} disabled={r === "owner" && !isOwner}>{LEVEL_NAMES[r]}{r === "owner" && !isOwner ? " (owner only)" : ""}</option>
                      ))}
                    </select>
                  )}
                  <div className="muted" style={{ fontSize: 12 }}>{person.role === "owner" ? "Everything" : describe(a, capped)}</div>
                </td>
              </tr>
            );
          })}
          <tr className={perms && person.role !== "owner" ? "perm-custom" : undefined}>
            <th scope="row">Permissions</th>
            <td>
              <label className="check">
                <input type="checkbox" checked={person.role === "owner" || perms} disabled={locked || !isOwner} onChange={(e) => { setPerms(e.target.checked); setSaved(false); }} />
                Can manage everyone&apos;s access on this page
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                {isOwner ? "They can't give owner-level access, give Permissions access, or change their own access." : "Only the owner can give Permissions access."}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <ErrorBox error={error} />
      {!locked && (
        <div className="row">
          <button className="btn primary" disabled={busy || !changed} onClick={() => run(async () => {
            const areasBody = Object.fromEntries(areas.map((a) => [a.key, draft[a.key] || null]));
            onSaved(await api<Person>(`/permissions/${person.id}`, { method: "PUT", body: { areas: areasBody, ...(isOwner ? { managesPermissions: perms } : {}) } }));
            setSaved(true);
          })}>Save access</button>
          {changed && <button className="btn" onClick={() => { setDraft(Object.fromEntries(areas.map((a) => [a.key, person.areas[a.key] ?? ""]))); setPerms(person.managesPermissions); }}>Undo changes</button>}
          {saved && !changed && <span className="muted" role="status">Saved. It takes effect right away.</span>}
        </div>
      )}
    </div>
  );
}

/** Settings → Permissions: who can do what, by area. Owners always; others if given Permissions access. */
export default function Permissions() {
  const { me } = useAuth();
  const allowed = me?.user.role === "owner" || !!me?.access?.managesPermissions;
  const data = useApi<{ areas: Area[]; people: Person[]; roleAccess: RoleAccess }>(allowed ? "/permissions" : null);
  const [selected, setSelected] = useState<string | null>(null);
  const people = data.data?.people ?? [];
  const customCount = (p: Person) => Object.keys(p.areas).length + (p.managesPermissions && p.role !== "owner" ? 1 : 0);
  const [filters, setFilters] = useState(NO_FILTERS);
  const setFilter = (patch: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = Object.values(filters).some(Boolean);
  const q = filters.q.trim().toLowerCase();
  const titles = [...new Set(people.map((p) => p.title).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b));
  const shown = people.filter((p) =>
    (!q || `${p.firstName} ${p.lastName} ${p.title ?? ""}`.toLowerCase().includes(q)) &&
    (!filters.role || p.role === filters.role) &&
    (!filters.title || (filters.title === NONE ? !p.title : p.title === filters.title)) &&
    (!filters.access ||
      (filters.access === "custom" && p.role !== "owner" && customCount(p) > 0) ||
      (filters.access === "role" && p.role !== "owner" && customCount(p) === 0) ||
      (filters.access === "permissions" && (p.role === "owner" || p.managesPermissions))) &&
    (!filters.area || !!p.areas[filters.area]));
  const person = shown.find((p) => p.id === selected) ?? shown.find((p) => p.role !== "owner" && p.id !== me?.user.id) ?? shown[0];

  return (
    <>
      <PageHead title="Permissions" sub="Who can do what in Crewdesk. Everyone starts with what their role gives them; change any area for any person here." />
      <SettingsTabs />
      {!allowed ? <p className="muted">Only the owner, and people they give Permissions access, can see this page.</p> : !data.data ? <ErrorBox error={data.error} /> : (
        <>
        <form className="card filters" role="search" aria-label="Filter people" onSubmit={(e) => e.preventDefault()}>
          <label>Search
            <input type="search" placeholder="Name or job title…" value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
          </label>
          <label>Role
            <select value={filters.role} onChange={(e) => setFilter({ role: e.target.value })}>
              <option value="">All roles</option>
              {(["owner", "admin", "manager", "employee"] as Role[]).map((r) => <option key={r} value={r}>{LEVEL_NAMES[r]} ({people.filter((p) => p.role === r).length})</option>)}
            </select>
          </label>
          <label>Job title
            <select value={filters.title} onChange={(e) => setFilter({ title: e.target.value })}>
              <option value="">All</option>
              {titles.map((t) => <option key={t} value={t}>{t}</option>)}
              <option value={NONE}>(no title)</option>
            </select>
          </label>
          <label>Access
            <select value={filters.access} onChange={(e) => setFilter({ access: e.target.value })}>
              <option value="">Everyone</option>
              <option value="custom">Custom access</option>
              <option value="role">Same as their role</option>
              <option value="permissions">Can manage Permissions</option>
            </select>
          </label>
          <label>Custom access in
            <select value={filters.area} onChange={(e) => setFilter({ area: e.target.value })}>
              <option value="">Any area</option>
              {data.data.areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </label>
          {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </form>
        <div className="perm-layout">
          <nav className="card perm-people" aria-label="People">
            {!shown.length && <p className="muted" style={{ padding: 8, margin: 0 }}>No one matches your filters.</p>}
            {shown.map((p) => (
              <button key={p.id} type="button" className={`perm-person${person?.id === p.id ? " active" : ""}`} onClick={() => setSelected(p.id)} aria-current={person?.id === p.id}>
                <span>{p.firstName} {p.lastName}<span className="muted" style={{ display: "block", fontSize: 12 }}>{LEVEL_NAMES[p.role]}{p.id === me?.user.id ? " · you" : ""}</span></span>
                {p.role === "owner" ? <span className="muted" style={{ fontSize: 12 }}>Full</span> : customCount(p) > 0 ? <span className="badge warn">{customCount(p)} custom</span> : null}
              </button>
            ))}
          </nav>
          {person && <PersonEditor person={person} areas={data.data.areas} roleAccess={data.data.roleAccess} onSaved={(p) => data.setData({ ...data.data!, people: people.map((x) => (x.id === p.id ? p : x)) })} />}
        </div>
        </>
      )}
    </>
  );
}
