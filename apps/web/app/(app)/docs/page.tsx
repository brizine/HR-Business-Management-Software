"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHead } from "@/components/ui";
import { DocTemplatesTab, DocumentsTab } from "@/components/marketing-docs";

/** Marketing → Documents, laid out like Homeworks: Documents | Document Templates. */
export default function MarketingDocsPage() {
  const tab = useSearchParams().get("tab") === "templates" ? "templates" : "documents";
  return (
    <div className="hw hwd" data-lkeep="">
      <PageHead title="Documents" />
      <nav className="hwd-tabs" aria-label="Documents">
        <Link href="/docs" className={tab === "documents" ? "active" : ""} aria-current={tab === "documents" ? "page" : undefined}>Documents</Link>
        <Link href="/docs?tab=templates" className={tab === "templates" ? "active" : ""} aria-current={tab === "templates" ? "page" : undefined}>Document Templates</Link>
      </nav>
      {tab === "templates" ? <DocTemplatesTab /> : <DocumentsTab />}
    </div>
  );
}
