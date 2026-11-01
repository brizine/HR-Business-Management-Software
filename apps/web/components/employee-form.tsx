"use client";
import { useState } from "react";
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, PAY_TYPES, ROLES, isInactive } from "@crewdesk/shared";
import { formValues } from "./ui";
import { ContactFields, withClearedContact } from "./contact-fields";
import { LabeledSelect, MenuSelect, useMenus } from "./menu-select";

export function EmployeeFields({ initial = {} as any, employees = [] as any[] }) {
  const [status, setStatus] = useState<string>(initial.status ?? "active");
  const menus = useMenus();
  return (
    <>
    <div className="formgrid">
      <label>First name<input name="firstName" defaultValue={initial.firstName} required /></label>
      <label>Last name<input name="lastName" defaultValue={initial.lastName} required /></label>
      <label>Email<input name="email" type="email" defaultValue={initial.email} required /></label>
      <label>Phone<input name="phone" defaultValue={initial.phone ?? ""} /></label>
      <MenuSelect name="title" label="Job title" options={menus.jobTitles} current={initial.title} />
      <MenuSelect name="department" label="Department" options={menus.departments} current={initial.department} />
      <label>Role
        <LabeledSelect menu="role" values={ROLES} name="role" defaultValue={initial.role ?? "employee"} />
      </label>
      <label>Manager
        <select name="managerId" defaultValue={initial.managerId ?? ""}>
          <option value="">—</option>
          {employees.filter((e) => e.id !== initial.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        </select>
      </label>
      <label>Employment type
        <LabeledSelect menu="employmentType" values={EMPLOYMENT_TYPES} name="employmentType" defaultValue={initial.employmentType ?? "full_time"} />
      </label>
      <label>Pay type
        <LabeledSelect menu="payType" values={PAY_TYPES} name="payType" defaultValue={initial.payType ?? "hourly"} />
      </label>
      <label>Pay rate ($/hr or $/yr)<input name="payRate" type="number" step="0.01" min="0" defaultValue={initial.payRateCents != null ? initial.payRateCents / 100 : ""} /></label>
      <label>Hire date<input name="startDate" type="date" defaultValue={initial.startDate ?? ""} /></label>
      <label>Status
        <LabeledSelect menu="employeeStatus" values={EMPLOYEE_STATUSES} name="status" value={status} onChange={(e) => setStatus(e.target.value)} />
      </label>
      {isInactive(status) && (
        <label style={{ gridColumn: "1 / -1" }}>Reason {status === "terminated" ? "for termination" : "they're inactive"} <span className="muted">(managers and admins only)</span>
          <textarea name="statusReason" rows={3} maxLength={2000} defaultValue={isInactive(initial.status) ? initial.statusReason ?? "" : ""}
            placeholder={status === "terminated" ? "e.g. Repeated no-shows after written warning on 9/12" : "e.g. Seasonal layoff, expected back in March"} />
        </label>
      )}
      <label>{initial.id ? "Reset password" : "App password (optional)"}<input name="password" type="password" minLength={8} autoComplete="new-password" /></label>
    </div>
    <ContactFields initial={initial} />
    </>
  );
}

/** Converts the form's dollar pay rate to cents and nulls an empty manager. */
export function employeeBody(form: HTMLFormElement) {
  const { payRate, ...v } = formValues(form);
  if (payRate != null) v.payRateCents = Math.round(payRate * 100);
  v.managerId = v.managerId ?? null;
  // "—" in a menu clears it.
  v.title = v.title ?? null;
  v.department = v.department ?? null;
  withClearedContact(v);
  // An emptied reason box clears the reason.
  v.statusReason = isInactive(v.status) ? v.statusReason ?? null : null;
  return v;
}
