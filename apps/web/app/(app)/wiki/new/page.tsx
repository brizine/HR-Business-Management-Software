"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { WikiShell } from "@/components/wiki";
import { WikiEditor } from "@/components/wiki-editor";

function NewPage() {
  const parent = useSearchParams().get("parent");
  const settings = useApi("/wiki/settings");
  if (!settings.data) return null;
  return (
    <WikiShell>
      <PageHead title="New wiki page" />
      {settings.data.canCreate ? <WikiEditor parentId={parent} /> : <ErrorBox error="Your company limits who can create wiki pages." />}
    </WikiShell>
  );
}

export default function Page() {
  return <Suspense><NewPage /></Suspense>;
}
