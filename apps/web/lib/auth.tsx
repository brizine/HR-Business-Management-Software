"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { hasRole, roleInArea, type AreaLevels, type PermissionArea, type Role } from "@crewdesk/shared";
import { api } from "./api";

export interface Me {
  user: { id: string; firstName: string; lastName: string; email: string; role: Role; employmentType?: string };
  company: { id: string; name: string };
  /** Access by area from the Permissions page (levels that differ from their role). */
  access?: { areas: AreaLevels; managesPermissions: boolean };
}

interface AuthCtx {
  me: Me | null;
  ready: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** At least `min` — in `area` if given, which counts any level set on the Permissions page. */
  can: (min: Role, area?: PermissionArea) => boolean;
}

const Ctx = createContext<AuthCtx>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** The API has just set the session cookie; load who's signed in. */
  const signIn = async () => {
    await load();
  };
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };
  const can = (min: Role, area?: PermissionArea) => !!me && hasRole(roleInArea(me.user.role, me.access?.areas, area), min);

  return <Ctx.Provider value={{ me, ready, signIn, signOut, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
