"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { RecordKind } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { RecordList } from "@/components/employee-records";
import { ReviewProgramBox } from "@/components/review-program";

function Reviews() {
  const { can } = useAuth();
  const manager = can("manager", "reviews");
  const params = useSearchParams();
  const router = useRouter();
  const [newKind, setNewKind] = useState<RecordKind | null>(null);
  const [newFor, setNewFor] = useState<{ employeeId?: string; type?: string } | null>(null);
  const [saved, setSaved] = useState(0);
  const start = (kind: RecordKind, prefill: { employeeId?: string; type?: string } | null = null) => {
    setNewKind(kind);
    setNewFor(prefill);
    requestAnimationFrame(() => document.querySelector(".record-form")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // From a "review due" reminder: /reviews?new=review&employee=…&type=…
  useEffect(() => {
    if (manager && params.get("new") === "review") {
      start("review", { employeeId: params.get("employee") ?? undefined, type: params.get("type") ?? undefined });
      router.replace("/reviews");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, params]);

  return (
    <>
      <PageHead title="Reviews & Discipline" sub={manager ? "Performance reviews and disciplinary actions. Drafts are only visible to managers until you share them." : "Reviews and disciplinary actions shared with you. Please acknowledge each one."}>
        {manager && <button className="btn" onClick={() => start("discipline")}>New disciplinary action</button>}
        {manager && <button className="btn primary" onClick={() => start("review")}>New review</button>}
      </PageHead>
      {manager && <ReviewProgramBox refreshKey={saved} onStart={(employeeId, type) => start("review", { employeeId, type })} />}
      <RecordList filterable openId={params.get("open")} newKind={newKind} newFor={newFor} onNewDone={() => { setNewKind(null); setNewFor(null); }} onSaved={() => setSaved((n) => n + 1)} />
    </>
  );
}

export default function Page() {
  return <Suspense><Reviews /></Suspense>;
}
