"use client";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { MenuEditors } from "@/components/menu-editors";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageLayoutsCard } from "@/components/page-layout";

export default function CompanySettings() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Company settings" sub="Owner only. Page layouts and the choices people pick from across Crewdesk." />
      <SettingsTabs />
      {!can("owner", "company") ? <p className="muted">Only the owner can change company settings.</p> : (
        <PageLayoutsCard>
          <MenuEditors />
        </PageLayoutsCard>
      )}
    </>
  );
}
