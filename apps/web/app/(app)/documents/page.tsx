"use client";
import { DocumentList } from "@/components/documents";
import { PageHead } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function Documents() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Documents" sub={can("manager") ? "All company and employee documents" : "Company documents and your personal file"} />
      <DocumentList title="All documents" />
    </>
  );
}
