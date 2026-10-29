import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { hasRole, type Role } from "@crewdesk/shared";
import { api, loadToken, saveToken } from "./api";

interface Me {
  user: { id: string; firstName: string; lastName: string; email: string; role: Role };
  company: { id: string; name: string };
}

interface AuthCtx {
  me: Me | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (min: Role) => boolean;
}

const Ctx = createContext<AuthCtx>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        if (await loadToken()) setMe(await api<Me>("/auth/me"));
      } catch {
        await saveToken(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const signIn = async (email: string, password: string) => {
    const res = await api<Me & { token: string }>("/auth/login", { body: { email, password } });
    await saveToken(res.token);
    setMe({ user: res.user, company: res.company });
  };
  const signOut = async () => {
    await saveToken(null);
    setMe(null);
  };

  return (
    <Ctx.Provider value={{ me, ready, signIn, signOut, can: (min) => !!me && hasRole(me.user.role, min) }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
