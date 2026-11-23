import type { PermissionArea, Role } from "@crewdesk/shared";

/**
 * The app's menus, laid out like Homeworks: a top bar on every page, and a left menu of icon groups
 * for the side you're on (Operations or Team). Each group pops out its pages, or lists them when the
 * menu is expanded.
 */
export type Side = "operations" | "team";
export const SIDES: { key: Side; label: string }[] = [{ key: "operations", label: "Operations" }, { key: "team", label: "Team" }];

export type NavItem = { href: string; label: string; min?: Role; area?: PermissionArea };
export type NavGroup = { key: string; label: string; icon: string; items: NavItem[] };

export const NAV: Record<Side, NavGroup[]> = {
  operations: [
    {
      key: "customers", label: "Customers", icon: "customers",
      items: [
        { href: "/customers", label: "Customers", min: "manager", area: "customers" },
        { href: "/properties", label: "Properties", min: "manager", area: "customers" },
        { href: "/custom-fields", label: "Custom fields", min: "admin" },
      ],
    },
    {
      key: "schedule", label: "Schedule", icon: "calendar",
      items: [
        { href: "/calendar", label: "Calendar" },
        { href: "/visits", label: "Work orders" },
        { href: "/todos", label: "To-dos" },
      ],
    },
    {
      key: "billing", label: "Billing", icon: "billing",
      items: [
        { href: "/invoices", label: "Invoices", min: "manager", area: "customers" },
        { href: "/price-list", label: "Price list", min: "manager", area: "customers" },
      ],
    },
    {
      key: "field", label: "Field", icon: "field",
      items: [
        { href: "/measure", label: "Property Measure" },
        { href: "/spray-mix", label: "Spray Mix Calculator" },
      ],
    },
    {
      key: "fleet", label: "Fleet", icon: "truck",
      items: [
        { href: "/fleet", label: "Assets" },
        { href: "/work-orders", label: "Repair Orders" },
        { href: "/inspections", label: "Inspections" },
      ],
    },
    { key: "reports", label: "Reports", icon: "reports", items: [{ href: "/reports/operations", label: "Operations reports", min: "manager", area: "fleet" }] },
  ],
  team: [
    { key: "dashboard", label: "Dashboard", icon: "dashboard", items: [{ href: "/dashboard", label: "Dashboard", min: "manager", area: "dashboard" }] },
    {
      key: "people", label: "People", icon: "people",
      items: [
        { href: "/people", label: "Team" },
        { href: "/schedule", label: "Shifts" },
        { href: "/crews", label: "Crews", min: "manager", area: "customers" },
        { href: "/time", label: "Time Clock" },
        { href: "/attendance", label: "Attendance" },
        { href: "/time-off", label: "Time Off" },
        { href: "/reviews", label: "Reviews & Discipline" },
        { href: "/training", label: "Training" },
        { href: "/documents", label: "Documents" },
        { href: "/onboarding", label: "Onboarding" },
        { href: "/hiring", label: "Hiring", min: "manager", area: "hiring" },
      ],
    },
    {
      key: "pay", label: "Pay", icon: "pay",
      items: [
        { href: "/payroll", label: "Payroll", min: "admin", area: "payroll" },
        // Opens Bigcapital in a new tab once it's connected; until then, the Integrations settings.
        { href: "/accounting", label: "Accounting", min: "admin", area: "payroll" },
        { href: "/tax-forms", label: "Pay & Tax Forms" },
      ],
    },
    { key: "reports", label: "Reports", icon: "reports", items: [{ href: "/reports/team", label: "Team reports", min: "manager" }] },
  ],
};

/** Pages that belong to a side without a menu item of their own. */
const EXTRA: Record<Side, string[]> = { operations: [], team: ["/pay-periods"] };

export const pathMatches = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Which side a page belongs to (null for shared pages such as Notifications, Wiki, Help and Settings). */
export function sideOf(path: string): Side | null {
  for (const side of ["operations", "team"] as Side[]) {
    if (NAV[side].some((g) => g.items.some((i) => pathMatches(path, i.href))) || EXTRA[side].some((h) => pathMatches(path, h))) return side;
  }
  return null;
}

/** The "+ New" menu, grouped; each opens the page with its add form showing. */
export type NewItem = { label: string; href: string; icon?: string; min?: Role; area?: PermissionArea };
export const NEW_MENU: { group: string; items: NewItem[] }[] = [
  {
    group: "Team & Resources",
    items: [
      { label: "Employee", href: "/people?new=1", icon: "user", min: "admin", area: "people" },
      { label: "Time off request", href: "/time-off?new=1", icon: "calendar" },
      { label: "Item & service", href: "/price-list?new=1", icon: "billing", min: "admin", area: "customers" },
      { label: "Equipment", href: "/fleet?new=1", icon: "truck", min: "manager", area: "fleet" },
    ],
  },
  {
    group: "Finance",
    items: [
      { label: "Invoice", href: "/invoices/new", icon: "billing", min: "manager", area: "customers" },
    ],
  },
  {
    group: "Events",
    items: [
      { label: "Work order", href: "/visits/new", icon: "clipboard", min: "manager", area: "customers" },
      { label: "To-do", href: "/todos?new=1", icon: "todo" },
      { label: "Repair order", href: "/work-orders?new=1", icon: "settings" },
    ],
  },
  {
    group: "Customer",
    items: [
      { label: "Customer", href: "/customers?new=1", icon: "user", min: "manager", area: "customers" },
      { label: "Property", href: "/properties?new=1", icon: "property", min: "manager", area: "customers" },
    ],
  },
];
