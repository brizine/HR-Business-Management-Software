"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHead } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { SendTextsTab, TextErrorsTab, TextMessagesTab } from "@/components/texting";

/** Homeworks' tabs, in its order. Text Message Templates opens Marketing → Templates, where the text templates are kept. */
const TABS = [
  ["messages", "Text Messages", "/texts"],
  ["send", "Send Text Messages", "/texts?tab=send"],
  ["templates", "Text Message Templates", "/templates?tab=text"],
  ["errors", "Error Log", "/texts?tab=errors"],
] as const;

/** Marketing → Text, laid out like Homeworks: conversations by text, sending to one or many, and what didn't go. */
export default function Texts() {
  const params = useSearchParams();
  const { can } = useAuth();
  const tab = params.get("tab") === "send" ? "send" : params.get("tab") === "errors" ? "errors" : "messages";
  return (
    <div className="hw txt" data-lkeep="">
      <PageHead title="Text" />
      <nav className="hw-pills" aria-label="Text">
        {TABS.filter(([k]) => k !== "templates" || can("manager", "customers")).map(([k, label, href]) => (
          <Link key={k} href={href} className={tab === k ? "active" : ""} aria-current={tab === k ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      {tab === "send" ? <SendTextsTab /> : tab === "errors" ? <TextErrorsTab /> : <TextMessagesTab />}
    </div>
  );
}
