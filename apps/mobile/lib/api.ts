import * as SecureStore from "expo-secure-store";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
/** The website, for links like "forgot password" (the API lives at <site>/api in production). */
export const WEB_URL = API_URL.replace(/\/api\/?$/, "");
const TOKEN_KEY = "crewdesk.token";
let token: string | null = null;

export async function loadToken() {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return token;
}

export async function saveToken(t: string | null) {
  token = t;
  if (t) await SecureStore.setItemAsync(TOKEN_KEY, t);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

let onSessionEnded: (() => void) | null = null;

/** Called when the API says the stored session is no longer valid (e.g. signed out everywhere). */
export function setSessionEndedHandler(fn: (() => void) | null) {
  onSessionEnded = fn;
}

/** `token` overrides the stored session (for the short-lived two-factor sign-in tokens). */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const auth = init.token ?? token;
  const res = await fetch(API_URL + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !init.token && token && !path.startsWith("/auth/login")) onSessionEnded?.();
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString() : "—");
export const fmtTime = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
