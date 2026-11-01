import { z } from "zod";
import { APPLICANT_STAGES, ASSET_TYPES, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, PAY_TYPES, WORK_ORDER_STATUSES } from "./schemas";
import { ROLES } from "./roles";
import { MIX_UNITS } from "./sprayMix";

/**
 * Drop-down menus the owner can edit (Settings → Company, and the layout editor's Edit drop-down
 * menus, which shows only the lists on the page being edited).
 *
 * - "list": plain names, fully editable (add, rename, reorder, remove). Job titles and departments
 *   have their own columns; the others are stored in companies.menu_lists.
 * - "labels": choices Crewdesk acts on (e.g. "inactive" locks someone out), so they can't be added
 *   or removed, but how each one reads can be renamed (companies.menu_labels).
 *
 * `pages` are layout page keys (see pageKey in the web app) where the menu appears.
 */
export const MENU_LISTS = [
  { key: "jobTitles", label: "Job titles", noun: "job title", kind: "list", pages: ["/people", "/people/:id", "/hiring"] },
  { key: "departments", label: "Departments", noun: "department", kind: "list", pages: ["/people", "/people/:id", "/hiring"] },
  { key: "employeeStatus", label: "Employee status", kind: "labels", values: EMPLOYEE_STATUSES, pages: ["/people", "/people/:id"] },
  { key: "role", label: "Role", kind: "labels", values: ROLES, pages: ["/people", "/people/:id", "/hiring"] },
  { key: "employmentType", label: "Employment type", kind: "labels", values: EMPLOYMENT_TYPES, pages: ["/people", "/people/:id", "/hiring"] },
  { key: "payType", label: "Pay type", kind: "labels", values: PAY_TYPES, pages: ["/people", "/people/:id", "/hiring"] },
  { key: "applicantStage", label: "Applicant stages", kind: "labels", values: APPLICANT_STAGES, pages: ["/hiring"] },
  { key: "documentCategories", label: "Document categories", noun: "category", kind: "list", defaults: ["general", "tax", "id", "policy", "certification", "contract", "registration", "insurance", "manual"], pages: ["/documents", "/people/:id", "/fleet/:id"] },
  { key: "mixUnits", label: "Spray Mix measurements", noun: "measurement", kind: "list", defaults: [...MIX_UNITS], pages: ["/spray-mix"] },
  { key: "assetTypes", label: "Asset types", noun: "asset type", kind: "list", defaults: [...ASSET_TYPES], pages: ["/fleet", "/fleet/:id"] },
  { key: "assetStatus", label: "Asset status", kind: "labels", values: ["active", "in_shop", "out_of_service", "retired"], pages: ["/fleet", "/fleet/:id"] },
  { key: "workOrderStatus", label: "Work order status", kind: "labels", values: WORK_ORDER_STATUSES, pages: ["/work-orders", "/fleet/:id"] },
  { key: "workOrderPriority", label: "Work order priority", kind: "labels", values: ["low", "medium", "high", "critical"], pages: ["/work-orders", "/fleet/:id"] },
] as const;

export type MenuKey = (typeof MENU_LISTS)[number]["key"];
/** Lists stored in companies.menu_lists (job titles and departments have their own columns). */
export const STORED_LISTS = ["documentCategories", "mixUnits", "assetTypes"] as const;
export type StoredList = (typeof STORED_LISTS)[number];
export type LabelMenu = Extract<(typeof MENU_LISTS)[number], { kind: "labels" }>["key"];
export const LABEL_MENUS = MENU_LISTS.filter((m) => m.kind === "labels").map((m) => m.key) as LabelMenu[];

/** How a fixed choice reads by default ("in_progress" → "in progress"). */
export const defaultLabel = (value: string) => value.replace(/_/g, " ");

const entry = z.string().trim().min(1).max(80);
export const menuListSchema = z.object({ values: z.array(entry).max(200).transform((l) => [...new Set(l)]) });
export const menuListRenameSchema = z.object({ from: entry, to: entry });
/** value → label; null or "" puts back the default wording. */
export const menuLabelsSchema = z.object({ labels: z.record(z.string(), z.string().trim().max(60).nullable()) });

/** The default stored lists, for companies that haven't edited them. */
export function defaultList(key: StoredList): string[] {
  const m = MENU_LISTS.find((x) => x.key === key)!;
  return "defaults" in m ? [...m.defaults] : [];
}

/** Menus that appear on a layout page. */
export const menusForPage = (page: string) => MENU_LISTS.filter((m) => (m.pages as readonly string[]).includes(page));
