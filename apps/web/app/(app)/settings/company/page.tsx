"use client";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageLayoutsCard } from "@/components/page-layout";

export default function CompanySettings() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Layout editor" sub="Owner only." />
      <SettingsTabs />
      {!can("owner", "company") ? <p className="muted">Only the owner can change company settings.</p> : (
        <PageLayoutsCard />
      )}
    </>
  );
}
