"use client";
import Link from "next/link";
import { formatTodoTime, todoState } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge } from "./ui";

interface Task {
  key: string;
  href: string;
  title: string;
  detail: string;
  badge?: string;
}

/**
 * Employee page: what's waiting on this person. On your own page ("My Tasks"): to-dos for the next week, repair orders, your
 * onboarding checklist, documents to sign, pay periods to approve and (managers) onboarding steps
 * waiting on you. Managers on someone else's page see their repair orders and onboarding checklist.
 */
export function TasksBox({ employeeId, firstName, isSelf }: { employeeId: string; firstName: string; isSelf: boolean }) {
  const { can } = useAuth();
  const workOrders = useApi<any[]>(isSelf ? "/work-orders?status=active&mine=true" : `/work-orders?status=active&assignedToId=${employeeId}`);
  const onboarding = useApi<any[]>(`/onboarding/tasks?open=true${isSelf ? "" : `&employeeId=${employeeId}`}`);
  const waitingOnMe = useApi<any[]>(isSelf && can("manager", "onboarding") ? "/onboarding/assigned" : null);
  const documents = useApi<any[]>(isSelf ? "/documents" : null);
  const payPeriods = useApi<{ canApprove: boolean; periods: any[] }>(isSelf ? "/pay-periods" : null);
  // To-dos through the next week (a manager sees someone else's only with To-dos manager access).
  const weekOut = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const todos = useApi<{ today: string; items: any[] }>(isSelf ? `/todos?mine=true&to=${weekOut}` : can("manager", "todos") ? `/todos?assigneeId=${employeeId}&to=${weekOut}` : null);

  const workOrders7 = useApi<{ items: any[] }>(isSelf ? `/visits?mine=true&status=active&to=${weekOut}` : can("manager", "customers") ? `/visits?assigneeId=${employeeId}&status=active&to=${weekOut}` : null);
  const tasks: Task[] = [
    ...(workOrders7.data?.items ?? []).map((v) => ({
      key: `visit-${v.id}`, href: `/visits/${v.id}`, title: `WO-${v.number} ${v.title}`,
      detail: ["Work order", v.date ? new Date(`${v.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "waitlist", formatTodoTime(v.startTime, v.endTime), v.property?.address].filter(Boolean).join(" · "),
      badge: v.status === "on_site" ? "on site" : v.date && v.date < (workOrders7.data as any).today ? "overdue" : undefined,
    })),
    ...(todos.data?.items ?? []).map((t) => {
      const state = todoState(t, todos.data!.today);
      return {
        key: `todo-${t.id}`, href: `/todos?open=${t.id}`, title: t.title,
        detail: ["To-do", new Date(`${t.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }), formatTodoTime(t.startTime, t.endTime), t.property?.address ?? t.location].filter(Boolean).join(" · "),
        badge: state === "overdue" ? "overdue" : state === "today" ? "today" : undefined,
      };
    }),
    ...(workOrders.data ?? []).map(({ workOrder: w, assetName }) => ({
      key: `wo-${w.id}`, href: `/work-orders?highlight=${w.id}`, title: `${w.number ? `#${w.number} ` : ""}${w.title}`,
      detail: `Repair order · ${assetName}${w.dueDate ? ` · due ${fmtDate(w.dueDate)}` : ""}`, badge: w.status,
    })),
    ...(onboarding.data ?? []).filter((t) => t.assignee === "employee").map((t) => ({
      key: `ob-${t.id}`, href: "/onboarding", title: t.title,
      detail: `Onboarding${t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}`, badge: t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) ? "overdue" : undefined,
    })),
    ...(documents.data ?? []).filter((d) => d.requiresSignature && !d.signedAt && d.employeeId === employeeId).map((d) => ({
      key: `doc-${d.id}`, href: "/documents", title: `Sign ${d.name}`, detail: "Document", badge: "pending",
    })),
    ...(payPeriods.data?.canApprove ? payPeriods.data.periods.filter((p) => p.status === "pending") : []).map((p) => ({
      key: `pay-${p.id}`, href: `/pay-periods/${p.id}`, title: `Approve pay period ${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`,
      detail: `Payroll · payday ${fmtDate(p.payday)}`, badge: "pending",
    })),
    ...(waitingOnMe.data ?? []).map((t) => ({
      key: `obm-${t.id}`, href: "/onboarding", title: `${t.title} (${t.employee.name})`,
      detail: `Onboarding${t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}`, badge: t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) ? "overdue" : undefined,
    })),
  ];
  const loading = !workOrders.data || !onboarding.data;

  return (
    <div className="card">
      <h2>{isSelf ? "My Tasks" : `${firstName}'s Tasks`}{tasks.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {tasks.length} open</span> : null}</h2>
      {tasks.length ? (
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.key}>
              <div style={{ minWidth: 0 }}>
                <Link href={t.href}>{t.title}</Link>
                <div className="muted" style={{ fontSize: 12 }}>{t.detail}</div>
              </div>
              {t.badge && <Badge value={t.badge} />}
            </li>
          ))}
        </ul>
      ) : !loading ? <p className="muted" style={{ margin: 0 }}>{isSelf ? "You're all caught up." : `Nothing waiting on ${firstName}.`}</p> : null}
    </div>
  );
}
