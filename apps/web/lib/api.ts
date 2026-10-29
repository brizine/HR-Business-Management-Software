export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const TOKEN_KEY = "crewdesk.token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Calls the API. `token` overrides the stored session (used for the
 * short-lived tokens in the two-factor sign-in steps).
 */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? getToken();
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(API_URL + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: isForm ? (init.body as FormData) : init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // The session ended (signed out everywhere, password changed, account disabled): back to sign-in.
    if (res.status === 401 && !init.token && token && typeof window !== "undefined" && !path.startsWith("/auth/login")) {
      setToken(null);
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    const detail = data.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(res.status, detail || data.error || res.statusText);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

/** Downloads an authenticated file (CSV export, document) via a blob URL. */
export async function download(path: string, filename: string) {
  const res = await fetch(API_URL + path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const money = (cents: number | null | undefined) =>
  cents == null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString() : "—");
export const fmtDateTime = (d: string | null | undefined) => (d ? new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
export const today = () => new Date().toISOString().slice(0, 10);
