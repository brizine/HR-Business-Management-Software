"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { hasRole, type Role } from "@crewdesk/shared";
import { api } from "./api";

export interface Me {
  user: { id: string; firstName: string; lastName: string; email: string; role: Role };
  company: { id: string; name: string };
}

interface AuthCtx {
  me: Me | null;
  ready: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (min: Role) => boolean;
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
  const can = (min: Role) => !!me && hasRole(me.user.role, min);

  return <Ctx.Provider value={{ me, ready, signIn, signOut, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
