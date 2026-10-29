"use client";
import { use } from "react";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { WikiShell } from "@/components/wiki";
import { WikiEditor } from "@/components/wiki-editor";

export default function EditWikiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useApi(`/wiki/pages/${id}`);
  return (
    <WikiShell currentId={id}>
      <PageHead title={data ? `Edit: ${data.title}` : "Edit page"} />
      {!data ? <ErrorBox error={error} /> : data.canEdit ? <WikiEditor page={data} /> : <ErrorBox error="You can read this page but not edit it." />}
    </WikiShell>
  );
}
