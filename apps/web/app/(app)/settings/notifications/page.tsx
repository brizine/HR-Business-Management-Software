"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { CompanyNotificationSettings, NotificationSettings } from "@/components/notification-settings";
import { PageHead } from "@/components/ui";

function Settings() {
  const employeeId = useSearchParams().get("employeeId") ?? undefined;
  const emp = useApi(employeeId ? `/employees/${employeeId}` : null);
  return (
    <>
      <PageHead
        title="Notification settings"
        sub={employeeId ? `For ${emp.data ? `${emp.data.firstName} ${emp.data.lastName}` : "…"}` : "Choose what reaches you, and how"}
      />
      <NotificationSettings employeeId={employeeId} />
      {!employeeId && <CompanyNotificationSettings />}
    </>
  );
}

export default function Page() {
  return <Suspense><Settings /></Suspense>;
}
