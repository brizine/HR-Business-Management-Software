"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { ActionHistory, AutomationList, ImportAutomations, ReviewTab, RunHistory } from "@/components/automations";

const TABS = [
  ["automations", "Automations"], ["sequences", "Sequence Automations"], ["sequence-history", "Sequence History"], ["review", "Review"], ["history", "Automation History"],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Marketing → Automations, laid out like Homeworks: Automations, Sequence Automations, Sequence
 * History, Review, Automation History, and the Text / Email template tabs (in Templates).
 */
export default function AutomationsPage() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const router = useRouter();
  const params = useSearchParams();
  const tab = ((params.get("tab") as Tab) || "automations") as Tab;
  const counts = useApi<{ review: number }>("/automations");
  const review = counts.data?.review ?? 0;
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHead title="Automations" sub="Emails, texts, tags and to-dos that go out on their own when something happens.">
        {admin && <ImportAutomations onDone={() => { counts.reload(); setVersion((v) => v + 1); }} />}
      </PageHead>
      <nav className="cal-seg text-tabs tpl-tabs" role="tablist" aria-label="Automations">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => router.replace(`/automations?tab=${k}`)}>
            {label}{k === "review" && review ? <span className="badge warn" style={{ marginLeft: 6 }}>{review}</span> : null}
          </button>
        ))}
        <Link href="/templates?tab=text" role="tab" className="au-tab-link">Text Message Templates</Link>
        <Link href="/templates?tab=email" role="tab" className="au-tab-link">Email Templates</Link>
      </nav>
      <AutomationTab key={`${tab}-${version}`} tab={tab} />
    </>
  );
}

function AutomationTab({ tab }: { tab: Tab }) {
  if (tab === "sequences") return <AutomationList kind="sequence" />;
  if (tab === "sequence-history") return <RunHistory kind="sequence" />;
  if (tab === "review") return <ReviewTab />;
  if (tab === "history") return <ActionHistory />;
  return <AutomationList kind="simple" />;
}
