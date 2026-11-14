"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RecordKind } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { RecordList } from "@/components/employee-records";

function Reviews() {
  const { can } = useAuth();
  const manager = can("manager", "reviews");
  const params = useSearchParams();
  const [newKind, setNewKind] = useState<RecordKind | null>(null);
  return (
    <>
      <PageHead title="Reviews & Discipline" sub={manager ? "Performance reviews and disciplinary actions. Drafts are only visible to managers until you share them." : "Reviews and disciplinary actions shared with you. Please acknowledge each one."}>
        {manager && <button className="btn" onClick={() => setNewKind("discipline")}>New disciplinary action</button>}
        {manager && <button className="btn primary" onClick={() => setNewKind("review")}>New review</button>}
      </PageHead>
      <RecordList filterable openId={params.get("open")} newKind={newKind} onNewDone={() => setNewKind(null)} />
    </>
  );
}

export default function Page() {
  return <Suspense><Reviews /></Suspense>;
}
