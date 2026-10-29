export const ROLES = ["owner", "admin", "manager", "employee"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { owner: 3, admin: 2, manager: 1, employee: 0 };

/** True when `role` is at least as privileged as `min`. */
export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
