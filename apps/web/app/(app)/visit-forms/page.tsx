"use client";
import { PageHead } from "@/components/ui";
import { VisitFormsList } from "@/components/visit-forms";

/** Marketing → Visit Forms, laid out like Homeworks: the forms crews fill in on work orders. */
export default function VisitFormsPage() {
  return (
    <div className="hw hwf" data-lkeep="">
      <PageHead title="Visit Forms" />
      <VisitFormsList />
    </div>
  );
}
