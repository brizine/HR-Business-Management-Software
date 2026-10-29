"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { hasRole, type Role } from "@crewdesk/shared";
import { api, getToken, setToken } from "./api";

export interface Me {
  user: { id: string; firstName: string; lastName: string; email: string; role: Role };
  company: { id: string; name: string };
}

interface AuthCtx {
  me: Me | null;
  ready: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  can: (min: Role) => boolean;
}

const Ctx = createContext<AuthCtx>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    if (!getToken()) return setReady(true);
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setToken(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const signIn = async (token: string) => {
    setToken(token);
    await load();
  };
  const signOut = () => {
    setToken(null);
    setMe(null);
  };
  const can = (min: Role) => !!me && hasRole(me.user.role, min);

  return <Ctx.Provider value={{ me, ready, signIn, signOut, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
