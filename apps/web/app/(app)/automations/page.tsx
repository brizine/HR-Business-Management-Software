"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { AutomationHistoryTab, AutomationsTab, ReviewTab, SequenceHistoryTab } from "@/components/automations";
import { SequencesTab } from "@/components/automation-sequences";

/** Homeworks' tabs, in its order. The two template tabs open Resources → Templates, as they open their own page there. */
const TABS = [
  ["automations", "Automations", "/automations?tab=automations"],
  ["sequences", "Sequence Automations", "/automations?tab=sequences"],
  ["sequence-history", "Sequence History", "/automations?tab=sequence-history"],
  ["review", "Review Sequence", "/automations?tab=review"],
  ["text-templates", "Text Message Templates", "/templates?tab=text"],
  ["email-templates", "Email Templates", "/templates?tab=email"],
  ["history", "Automation History", "/automations?tab=history"],
] as const;

/** Resources → Automations, laid out like Homeworks. */
export default function AutomationsPage() {
  const params = useSearchParams();
  const tab = params.get("tab") || "automations";
  const edit = params.get("edit");
  const isNew = params.get("new") === "1";
  const counts = useApi<{ review: number }>("/automations");
  const review = counts.data?.review ?? 0;
  return (
    <div className="hw" data-lkeep="">
      <PageHead title="Automations" />
      <nav className="hw-pills" aria-label="Automations">
        {TABS.map(([k, label, href]) => (
          <Link key={k} href={href} className={tab === k ? "active" : ""} aria-current={tab === k ? "page" : undefined}>
            {label}{k === "review" && review > 0 ? <span className="hw-count">{review}</span> : null}
          </Link>
        ))}
      </nav>
      {tab === "sequences" ? <SequencesTab edit={edit} isNew={isNew} />
        : tab === "sequence-history" ? <SequenceHistoryTab />
        : tab === "review" ? <ReviewTab onChanged={counts.reload} />
        : tab === "history" ? <AutomationHistoryTab />
        : <AutomationsTab edit={edit} isNew={isNew} />}
    </div>
  );
}
