"use client";
import { EMPLOYMENT_TYPES, PAY_TYPES, ROLES } from "@crewdesk/shared";
import { formValues } from "./ui";

export function EmployeeFields({ initial = {} as any, employees = [] as any[] }) {
  return (
    <div className="formgrid">
      <label>First name<input name="firstName" defaultValue={initial.firstName} required /></label>
      <label>Last name<input name="lastName" defaultValue={initial.lastName} required /></label>
      <label>Email<input name="email" type="email" defaultValue={initial.email} required /></label>
      <label>Phone<input name="phone" defaultValue={initial.phone ?? ""} /></label>
      <label>Job title<input name="title" defaultValue={initial.title ?? ""} /></label>
      <label>Department<input name="department" defaultValue={initial.department ?? ""} /></label>
      <label>Role
        <select name="role" defaultValue={initial.role ?? "employee"}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
      </label>
      <label>Manager
        <select name="managerId" defaultValue={initial.managerId ?? ""}>
          <option value="">—</option>
          {employees.filter((e) => e.id !== initial.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        </select>
      </label>
      <label>Employment type
        <select name="employmentType" defaultValue={initial.employmentType ?? "full_time"}>{EMPLOYMENT_TYPES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}</select>
      </label>
      <label>Pay type
        <select name="payType" defaultValue={initial.payType ?? "hourly"}>{PAY_TYPES.map((r) => <option key={r}>{r}</option>)}</select>
      </label>
      <label>Pay rate ($/hr or $/yr)<input name="payRate" type="number" step="0.01" min="0" defaultValue={initial.payRateCents != null ? initial.payRateCents / 100 : ""} /></label>
      <label>Start date<input name="startDate" type="date" defaultValue={initial.startDate ?? ""} /></label>
      <label>Status
        <select name="status" defaultValue={initial.status ?? "active"}>{["active", "onboarding", "inactive"].map((s) => <option key={s}>{s}</option>)}</select>
      </label>
      <label>{initial.id ? "Reset password" : "App password (optional)"}<input name="password" type="password" minLength={8} autoComplete="new-password" /></label>
    </div>
  );
}

/** Converts the form's dollar pay rate to cents and nulls an empty manager. */
export function employeeBody(form: HTMLFormElement) {
  const { payRate, ...v } = formValues(form);
  if (payRate != null) v.payRateCents = Math.round(payRate * 100);
  v.managerId = v.managerId ?? null;
  return v;
}
