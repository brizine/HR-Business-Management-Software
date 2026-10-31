"use client";
import Link from "next/link";
import { Fragment, Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EMPLOYEE_STATUSES } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";
import { EmployeeFields, employeeBody } from "@/components/employee-form";
import { InviteResult } from "@/components/invite-result";
import { Avatar } from "@/components/avatar";

const NONE = "__none";
const FILTER_KEYS = ["q", "status", "title", "dept", "hiredFrom", "hiredTo", "payType", "payMin", "payMax"] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

/** Distinct values of a field, sorted, for a filter dropdown. */
const distinct = (rows: any[], key: string) =>
  [...new Set(rows.map((r) => r[key]).filter((v): v is string => !!v && v.trim() !== ""))].sort((a, b) => a.localeCompare(b));

function matches(e: any, f: Filters) {
  if (f.q && !`${e.firstName} ${e.lastName} ${e.email} ${e.title ?? ""} ${e.department ?? ""}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.title && (f.title === NONE ? !!e.title : e.title !== f.title)) return false;
  if (f.dept && (f.dept === NONE ? !!e.department : e.department !== f.dept)) return false;
  // Hire date range (YYYY-MM-DD compares correctly as text); no hire date never matches a range.
  if (f.hiredFrom && !(e.startDate && e.startDate >= f.hiredFrom)) return false;
  if (f.hiredTo && !(e.startDate && e.startDate <= f.hiredTo)) return false;
  if (f.payType && e.payType !== f.payType) return false;
  // Pay range in dollars (per hour for hourly, per year for salaried).
  const dollars = (e.payRateCents ?? 0) / 100;
  if (f.payMin !== "" && dollars < Number(f.payMin)) return false;
  if (f.payMax !== "" && dollars > Number(f.payMax)) return false;
  return true;
}

function People() {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>("/employees");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<any>(null);
  const { busy, error, run } = useAction();

  // Filters live in the address bar, so a filtered view can be bookmarked or shared.
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])) as Filters;
  const setFilter = (patch: Partial<Filters>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    // Pay range only applies to one pay type at a time.
    if (patch.payType !== undefined && patch.payType !== filters.payType) {
      next.delete("payMin");
      next.delete("payMax");
    }
    router.replace(`${path}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  const active = FILTER_KEYS.some((k) => filters[k]);
  const all = data ?? [];
  const titles = useMemo(() => distinct(all, "title"), [all]);
  const depts = useMemo(() => distinct(all, "department"), [all]);
  const rows = all.filter((e) => matches(e, filters));
  const seesPay = can("manager");
  // How many people have each status, given the other filters (so the numbers add up to what "All" shows).
  const byStatus = all.filter((e) => matches(e, { ...filters, status: "" })).reduce<Record<string, number>>((n, e) => ({ ...n, [e.status]: (n[e.status] ?? 0) + 1 }), {});
  const statusTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const otherFilters = FILTER_KEYS.some((k) => k !== "status" && filters[k]);
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const summary = filters.status
    ? `${rows.length} ${filters.status}${otherFilters ? " matching your filters" : ""} · ${people(all.length)} in all`
    : active ? `Showing ${rows.length} of ${people(all.length)}` : people(all.length);

  const filterControls = {
    search: (
      <label>Search
        <input type="search" placeholder="Name, email…" value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
      </label>
    ),
    status: (
      <label>Status
        <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
          <option value="">All ({statusTotal})</option>
          {EMPLOYEE_STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)} ({byStatus[s] ?? 0})</option>)}
        </select>
      </label>
    ),
    jobTitle: (
      <label>Job title
        <select value={filters.title} onChange={(e) => setFilter({ title: e.target.value })}>
          <option value="">All</option>
          {titles.map((t) => <option key={t} value={t}>{t}</option>)}
          <option value={NONE}>(no title)</option>
        </select>
      </label>
    ),
    department: (
      <label>Department
        <select value={filters.dept} onChange={(e) => setFilter({ dept: e.target.value })}>
          <option value="">All</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          <option value={NONE}>(no department)</option>
        </select>
      </label>
    ),
    hired: (
      <fieldset className="pay-range date-range">
        <legend>Hired</legend>
        <input type="date" aria-label="Hired on or after" value={filters.hiredFrom} max={filters.hiredTo || undefined} onChange={(e) => setFilter({ hiredFrom: e.target.value })} />
        <span aria-hidden="true">–</span>
        <input type="date" aria-label="Hired on or before" value={filters.hiredTo} min={filters.hiredFrom || undefined} onChange={(e) => setFilter({ hiredTo: e.target.value })} />
      </fieldset>
    ),
    pay: seesPay && (
      <>
        <label>Pay type
          <select value={filters.payType} onChange={(e) => setFilter({ payType: e.target.value })}>
            <option value="">All</option>
            <option value="hourly">Hourly</option>
            <option value="salary">Salaried</option>
          </select>
        </label>
        {filters.payType && (
          <fieldset className="pay-range">
            <legend>Pay {filters.payType === "hourly" ? "($/hour)" : "($/year)"}</legend>
            <input type="number" inputMode="decimal" min="0" step="any" aria-label="Minimum pay" placeholder="Min" value={filters.payMin} onChange={(e) => setFilter({ payMin: e.target.value })} />
            <span aria-hidden="true">–</span>
            <input type="number" inputMode="decimal" min="0" step="any" aria-label="Maximum pay" placeholder="Max" value={filters.payMax} onChange={(e) => setFilter({ payMax: e.target.value })} />
          </fieldset>
        )}
      </>
    ),
  };



  return (
    <>
      <PageHead title="Team" sub={<span role="status">{summary}</span>}>
        {can("admin") && <button className="btn primary" onClick={() => setAdding(!adding)}>Add employee</button>}
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter the team" onSubmit={(e) => e.preventDefault()}>
        {Object.entries(filterControls).map(([k, control]) => <Fragment key={k}>{control}</Fragment>)}
        {active && <button type="button" className="btn" onClick={() => router.replace(path, { scroll: false })}>Clear filters</button>}
      </form>
      {added && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Added {added.firstName} {added.lastName}</h2>
            <button className="btn sm" onClick={() => setAdded(null)}>Close</button>
          </div>
          {added.hasLogin ? <p className="muted">They can sign in with the password you set.</p> : <InviteResult invite={added.invite} name={added.firstName} email={added.email} />}
        </div>
      )}
      {adding && (
        <div className="card">
          <h2>New employee</h2>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const body = employeeBody(e.currentTarget);
              run(async () => {
                setAdded(await api("/employees", { body }));
                setAdding(false);
                reload();
              });
            }}
          >
            <EmployeeFields employees={data ?? []} />
            <label className="check"><input type="checkbox" name="sendInvite" defaultChecked /> If no password is set, email them an invite to set up their own account</label>
            <ErrorBox error={error} />
            <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Job title</th><th>Department</th><th>Hired</th><th>Contact</th>{seesPay && <th>Pay</th>}<th>Status</th></tr></thead>
          <tbody>
            {data && !rows.length && (
              <tr><td colSpan={seesPay ? 7 : 6} className="empty">No one matches these filters. <a href="#" onClick={(ev) => { ev.preventDefault(); router.replace(path, { scroll: false }); }}>Clear filters</a></td></tr>
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <td>
                  <div className="person-cell">
                    <Avatar e={e} size={36} />
                    <div><Link href={`/people/${e.id}`}>{e.firstName} {e.lastName}</Link><div className="muted">{e.role}</div></div>
                  </div>
                </td>
                <td>{e.title ?? "—"}</td>
                <td>{e.department ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDate(e.startDate)}</td>
                <td>{e.email}<div className="muted">{e.phone}</div></td>
                {seesPay && <td>{money(e.payRateCents)}{e.payType === "hourly" ? "/hr" : "/yr"}</td>}
                <td>
                  <Badge value={e.status} />
                  {e.statusReason && <div className="muted status-reason-short" title={e.statusReason}>{e.statusReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense><People /></Suspense>;
}
