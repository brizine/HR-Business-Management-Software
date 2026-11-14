"use client";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isInactive } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { CompanyNotificationSettings, NotificationSettings } from "@/components/notification-settings";
import { PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";

/** Owners and admins pick whose notification settings to change (yours, or any employee's). */
function PersonPicker({ employeeId }: { employeeId?: string }) {
  const { me } = useAuth();
  const router = useRouter();
  const staff = useApi<any[]>("/employees");
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status) || e.id === employeeId)
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
  return (
    <div className="card row" style={{ gap: 10, alignItems: "flex-end" }}>
      <label style={{ width: 320 }}>Change notification settings for
        <select value={employeeId ?? ""} onChange={(e) => router.push(e.target.value && e.target.value !== me?.user.id ? `/settings/notifications?employeeId=${e.target.value}` : "/settings/notifications")}>
          <option value="">Me ({me?.user.firstName} {me?.user.lastName})</option>
          {people.filter((e) => e.id !== me?.user.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}{e.title ? ` · ${e.title}` : ""}</option>)}
        </select>
      </label>
      <span className="muted" style={{ fontSize: 13, paddingBottom: 8 }}>Choose a person to set which alerts they get, and by app, email or text.</span>
    </div>
  );
}

function Settings() {
  const { can } = useAuth();
  const employeeId = useSearchParams().get("employeeId") ?? undefined;
  const emp = useApi(employeeId ? `/employees/${employeeId}` : null);
  const admin = can("admin", "people");
  return (
    <>
      <PageHead
        title="Notification Settings"
        sub={employeeId ? `For ${emp.data ? `${emp.data.firstName} ${emp.data.lastName}` : "…"}` : "Choose what reaches you, and how"}
      />
      <SettingsTabs />
      {admin && <PersonPicker employeeId={employeeId} />}
      <NotificationSettings key={employeeId ?? "me"} employeeId={employeeId} />
      {!employeeId && <CompanyNotificationSettings />}
    </>
  );
}

export default function Page() {
  return <Suspense><Settings /></Suspense>;
}
