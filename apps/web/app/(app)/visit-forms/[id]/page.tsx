"use client";
import Link from "next/link";
import { use } from "react";
import { ErrorBox, PageHead } from "@/components/ui";
import { FormBuilder, type VisitFormFull } from "@/components/visit-forms";
import { useApi } from "@/lib/hooks";

/** Resources → Visit Forms → a form. */
export default function VisitFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const form = useApi<VisitFormFull>(`/visit-forms/${id}`);
  return (
    <div className="hw hwf" data-lkeep="">
      <PageHead title="Visit Form" before={<Link className="btn" href="/visit-forms" aria-label="Back to visit forms">←</Link>} />
      <ErrorBox error={form.error} />
      {form.data && <FormBuilder key={form.data.id} form={form.data} />}
    </div>
  );
}
