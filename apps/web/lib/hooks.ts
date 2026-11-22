"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** Fetches `path` on mount (and when it changes); `reload` refetches. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Wraps an async action with busy/error state for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/**
 * Opens a page's add form when it's reached from the top bar's "+ New" menu (`?new=1`), then tidies
 * the address. Also works when already on the page (the menu fires "crewdesk:new").
 */
export function useNewForm(open: () => void) {
  useEffect(() => {
    const check = () => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("new") !== "1") return;
      open();
      url.searchParams.delete("new");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    };
    check();
    window.addEventListener("crewdesk:new", check);
    return () => window.removeEventListener("crewdesk:new", check);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
