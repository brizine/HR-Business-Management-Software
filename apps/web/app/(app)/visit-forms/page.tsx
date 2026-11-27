"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHead } from "@/components/ui";
import { SubmittedForms, VisitFormsList } from "@/components/visit-forms";

/** Resources → Visit Forms, laid out like Homeworks: the forms crews fill in on work orders, and the ones they've submitted. */
export default function VisitFormsPage() {
  const params = useSearchParams();
  const submitted = params.get("tab") === "submitted";
  return (
    <div className="hw hwf" data-lkeep="">
      <PageHead title="Visit Forms" />
      <nav className="hw-pills" aria-label="Visit Forms">
        <Link href="/visit-forms" className={submitted ? "" : "active"} aria-current={submitted ? undefined : "page"}>Forms</Link>
        <Link href="/visit-forms?tab=submitted" className={submitted ? "active" : ""} aria-current={submitted ? "page" : undefined}>Submitted</Link>
      </nav>
      {submitted ? <SubmittedForms customerId={params.get("customerId") ?? undefined} /> : <VisitFormsList />}
    </div>
  );
}
