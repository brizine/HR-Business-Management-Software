"use client";
import Link from "next/link";
import type { PermissionArea, Role } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { Empty, PageHead } from "./ui";

export interface ReportLink { title: string; about: string; href: string; min: Role; area?: PermissionArea }

/** A Reports page for one side of the menu: cards linking to the reports you can see. */
export function ReportsHub({ title, sub, reports, note }: { title: string; sub: string; reports: ReportLink[]; note?: string }) {
  const { can } = useAuth();
  const shown = reports.filter((r) => can(r.min, r.area));
  return (
    <>
      <PageHead title={title} sub={sub} />
      {shown.length ? (
        <div className="report-grid">
          {shown.map((r) => (
            <Link key={r.href} href={r.href} className="card report-card">
              <strong>{r.title}</strong>
              <span className="muted">{r.about}</span>
            </Link>
          ))}
        </div>
      ) : <Empty>No reports for your role here yet.</Empty>}
      {note && <p className="muted" style={{ fontSize: 13 }}>{note}</p>}
    </>
  );
}
