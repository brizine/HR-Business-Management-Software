"use client";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { FormBuilder } from "@/components/visit-forms";

/** Marketing → Visit Forms → New Form. */
export default function NewVisitFormPage() {
  return (
    <div className="hw hwf" data-lkeep="">
      <PageHead title="Visit Form" before={<Link className="btn" href="/visit-forms" aria-label="Back to visit forms">←</Link>} />
      <FormBuilder />
    </div>
  );
}
