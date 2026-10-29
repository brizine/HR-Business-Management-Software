import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { hasRole, type Role } from "@crewdesk/shared";
import { api, loadToken, saveToken, setSessionEndedHandler } from "./api";
import { registerForPush, unregisterForPush } from "./push";

interface Me {
  user: { id: string; firstName: string; lastName: string; email: string; role: Role };
  company: { id: string; name: string };
}

export type SignInStep = { kind: "done" } | { kind: "code"; mfaToken: string } | { kind: "setup"; setupToken: string };

interface AuthCtx {
  me: Me | null;
  ready: boolean;
  /** Returns the next step when two-factor is needed; otherwise signs in. */
  signIn: (email: string, password: string) => Promise<SignInStep>;
  /** Finishes signing in with a session token from the two-factor steps. */
  completeSignIn: (token: string) => Promise<void>;
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

  // Register this device for push whenever someone is signed in.
  useEffect(() => {
    if (me) registerForPush().catch((e) => console.warn("Push registration failed", e));
  }, [me?.user.id]);

  const signIn = async (email: string, password: string): Promise<SignInStep> => {
    const res = await api("/auth/login", { body: { email, password } });
    if (res.mfaRequired) return { kind: "code", mfaToken: res.mfaToken };
    if (res.mfaSetupRequired) return { kind: "setup", setupToken: res.setupToken };
    await completeSignIn(res.token);
    return { kind: "done" };
  };
  const completeSignIn = async (sessionToken: string) => {
    await saveToken(sessionToken);
    setMe(await api<Me>("/auth/me"));
  };

  // If the server ends the session (signed out everywhere, password changed), drop back to sign-in.
  useEffect(() => {
    setSessionEndedHandler(() => {
      saveToken(null);
      setMe(null);
    });
    return () => setSessionEndedHandler(null);
  }, []);
  const signOut = async () => {
    await unregisterForPush();
    await saveToken(null);
    setMe(null);
  };

  return (
    <Ctx.Provider value={{ me, ready, signIn, completeSignIn, signOut, can: (min) => !!me && hasRole(me.user.role, min) }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
