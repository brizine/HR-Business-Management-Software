import { hasRole, type Role } from "./roles";

/**
 * Who can do what, by area. Everyone gets the access their role gives them in each area; the
 * Permissions page can give a person a different level in an area (higher or lower). Owners always
 * have full access everywhere. A level is one of the roles: what a "manager" can do in Payroll is
 * what a manager could do there by default, and so on.
 */
export const PERMISSION_AREAS = [
  {
    key: "people", label: "Team & employee records", max: "admin",
    levels: { manager: "See pay, home addresses, emergency contacts and time-off reasons", admin: "Add and edit employees, send invites, sign people out, reset two-factor" },
  },
  { key: "time", label: "Time clock", levels: { manager: "See and approve everyone's timesheets, fix punches", admin: "Set clock-in location rules and job sites" } },
  { key: "schedule", label: "Schedule", levels: { manager: "Create, publish and change shifts and templates; see availability" } },
  { key: "timeoff", label: "Time off", levels: { manager: "Approve or deny requests, request for others, see balances", admin: "Edit policies and adjust balances" } },
  { key: "documents", label: "Documents", levels: { manager: "See and upload everyone's documents" } },
  {
    key: "reviews", label: "Reviews & discipline",
    levels: { manager: "Write reviews and disciplinary actions, and see everyone's", admin: "Edit or delete shared records" },
  },
  {
    key: "training", label: "Training",
    levels: { manager: "Assign courses and see everyone's progress", admin: "Create and edit courses, lessons and quizzes" },
  },
  { key: "hiring", label: "Hiring", levels: { manager: "Post jobs, move applicants, hire" } },
  { key: "onboarding", label: "Onboarding", levels: { manager: "See new hires' checklists and do manager steps", admin: "Edit checklist templates and do admin steps" } },
  { key: "payroll", label: "Payroll & tax forms", levels: { admin: "Preview and export payroll, see tax forms, reopen pay periods", owner: "Payroll settings and pay schedule" } },
  { key: "fleet", label: "Fleet & equipment", levels: { manager: "Add and edit assets, assign work orders, set maintenance schedules" } },
  { key: "wiki", label: "Company wiki", levels: { manager: "See manager-level pages", admin: "See and edit admin-level pages, change who can see or edit pages" } },
  { key: "spray", label: "Spray Mix Calculator", levels: { admin: "Edit every mix and choose who else can edit" } },
  { key: "dashboard", label: "Dashboard", levels: { manager: "See the dashboard" } },
  { key: "company", label: "Company settings", levels: { owner: "Page layouts, job titles and departments, two-factor rules" } },
] as const satisfies readonly { key: string; label: string; max?: Role; levels: Partial<Record<Role, string>> }[];

export type PermissionArea = (typeof PERMISSION_AREAS)[number]["key"];
export const PERMISSION_AREA_KEYS = PERMISSION_AREAS.map((a) => a.key) as PermissionArea[];

/** Per-person levels by area, as stored. */
export type AreaLevels = Partial<Record<PermissionArea, Role>>;

/** Roles whose access by area the owner can set (owners always have full access). */
export const CONFIGURABLE_ROLES = ["employee", "manager", "admin"] as const satisfies readonly Role[];
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];
/** Access by area for each role, as the owner set it (Settings → Layout Editor); areas left out get the role itself. */
export type RoleAccess = Partial<Record<ConfigurableRole, AreaLevels>>;

/** What everyone with this role gets in an area: the owner's setting for the role, else the role itself (capped). */
export function roleDefaultLevel(role: Role, roleAccess: RoleAccess | null | undefined, area: PermissionArea): Role {
  if (role === "owner") return role;
  return roleInArea(role, roleAccess?.[role as ConfigurableRole], area);
}

/**
 * A person's access by area that differs from their role itself: their role's settings, with
 * anything set for them personally on the Permissions page on top.
 */
export function effectiveAreaLevels(role: Role, roleAccess: RoleAccess | null | undefined, personal: AreaLevels | undefined): AreaLevels {
  if (role === "owner") return {};
  return { ...(roleAccess?.[role as ConfigurableRole] ?? {}), ...(personal ?? {}) };
}

/** The most a person can be given in an area (Team stops at admin, so nobody else can manage owners' accounts). */
export function maxLevel(area: PermissionArea): Role {
  const a = PERMISSION_AREAS.find((x) => x.key === area);
  return (a && "max" in a ? a.max : "owner") as Role;
}

/** What a person can do in an area: owners everything; otherwise their override (capped), else their role. */
export function roleInArea(role: Role, levels: AreaLevels | undefined, area: PermissionArea | undefined): Role {
  if (role === "owner" || !area) return role;
  const level = levels?.[area];
  if (!level) return role;
  const max = maxLevel(area);
  return hasRole(level, max) ? max : level;
}
