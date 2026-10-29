"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { CompanyNotificationSettings, NotificationSettings } from "@/components/notification-settings";
import { PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";

function Settings() {
  const employeeId = useSearchParams().get("employeeId") ?? undefined;
  const emp = useApi(employeeId ? `/employees/${employeeId}` : null);
  return (
    <>
      <PageHead
        title="Notification settings"
        sub={employeeId ? `For ${emp.data ? `${emp.data.firstName} ${emp.data.lastName}` : "…"}` : "Choose what reaches you, and how"}
      />
      {!employeeId && <SettingsTabs />}
      <NotificationSettings employeeId={employeeId} />
      {!employeeId && <CompanyNotificationSettings />}
    </>
  );
}

export default function Page() {
  return <Suspense><Settings /></Suspense>;
}
