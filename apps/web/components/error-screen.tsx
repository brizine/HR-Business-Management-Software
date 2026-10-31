"use client";
import { useEffect } from "react";

const RELOADED = "crewdesk.reloaded-for-update";

/** True when the page was loaded before Crewdesk was updated and its files are gone. */
const isStaleBuild = (error: Error) => /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(`${error.name} ${error.message}`);

/**
 * Shown instead of a blank "Application error" page. If the cause is an update (the tab was
 * open while Crewdesk was rebuilt), it reloads once by itself to pick up the new version.
 */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleBuild(error);
  useEffect(() => {
    console.error(error);
    if (!stale) return;
    try {
      if (sessionStorage.getItem(RELOADED)) return;
      sessionStorage.setItem(RELOADED, "1");
    } catch {}
    window.location.reload();
  }, [error, stale]);
  useEffect(() => {
    // Loaded fine this time: allow a future update to reload by itself again.
    const t = setTimeout(() => { try { sessionStorage.removeItem(RELOADED); } catch {} }, 10_000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>{stale ? "Crewdesk was updated" : "Something went wrong"}</h1>
      <p style={{ color: "#667085", marginTop: 0 }}>
        {stale ? "This page was opened before the update. Reload to get the new version." : "This page hit a problem. Reloading usually fixes it. If it keeps happening, let your admin know what you were doing."}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        {!stale && <button className="btn" onClick={reset}>Try again</button>}
        <a className="btn" href="/dashboard">Go to dashboard</a>
      </div>
      {error.digest && <p style={{ color: "#98a2b3", fontSize: 12, marginTop: 16 }}>Error code: {error.digest}</p>}
    </div>
  );
}
