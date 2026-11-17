"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isInactive } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import { CompanyNotificationSettings, NotificationSettings } from "@/components/notification-settings";
import { ErrorBox, PageHead } from "@/components/ui";
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

type TestResult = { devices: number; results: { platform: string; lastSeenAt: string; ok: boolean; error: string | null }[] };

/** Sends a push to your own phones right now, to check notifications reach them. */
function TestPush() {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<TestResult | null>(null);
  const phone = (p: string) => (p === "ios" ? "iPhone" : p === "android" ? "Android phone" : p);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>Test Push Notifications</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Sends a notification to every phone where you&apos;re signed in to the app (installed from TestFlight, the App Store or
            Google Play; Expo Go can&apos;t receive them). It ignores your settings above.
          </p>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => setResult(await api<TestResult>("/notifications/test-push", { method: "POST" })))}>
          {busy ? "Sending…" : "Send a test notification to my phone"}
        </button>
      </div>
      <ErrorBox error={error} />
      {result && (result.devices === 0 ? (
        <p style={{ margin: 0 }}>⚠ No phone is registered for you yet. Install the app (TestFlight or a test build), sign in, and tap <strong>Allow</strong> when it asks about notifications. Then try again.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {result.results.map((x, i) => (
            <li key={i}>
              {x.ok ? "✅" : "❌"} {phone(x.platform)} (last signed in {new Date(x.lastSeenAt).toLocaleDateString()}):{" "}
              {x.ok ? "sent. It should pop up within a few seconds." : <>not delivered: <span className="muted">{x.error}</span></>}
            </li>
          ))}
        </ul>
      ))}
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
      {!employeeId && <TestPush />}
      {!employeeId && <CompanyNotificationSettings />}
    </>
  );
}

export default function Page() {
  return <Suspense><Settings /></Suspense>;
}
