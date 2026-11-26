import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folders whose contents decide how the site behaves. */
const FOLDERS = ["apps/api/drizzle", "apps/api/src", "apps/web/app", "apps/web/components", "apps/web/lib", "packages/shared/src"];

/** The top of the repo, found from wherever this code runs (source, tests or the built server). */
export function repoRoot(from = dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dir === dirname(dir)) return null;
  }
}

/**
 * A short fingerprint of the code in a copy of the repo: the same commit gives the same answer on
 * any machine. The live site reports its own at /api/health, so "is this commit live yet?" can be
 * answered from outside. Updates to the phone app wait for it (scripts/app-update.mjs), so phones
 * never get screens before the server they talk to.
 *
 * Kept to syntax Node runs directly (type notes only, no imports from the app): that script loads
 * this file as it is, without a build.
 */
export function sourceStamp(root = repoRoot()) {
  if (!root) return null;
  const hash = createHash("sha256");
  const walk = (folder: string) => {
    const entries = readdirSync(join(root, folder), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(`${path}\0`).update(readFileSync(join(root, path))).update("\0");
    }
  };
  for (const folder of FOLDERS) if (existsSync(join(root, folder))) walk(folder);
  return hash.digest("hex").slice(0, 16);
}

let live: string | null | undefined;
/** This server's own stamp, worked out once. Null when the code's folders can't be read. */
export function liveStamp() {
  if (live === undefined) {
    try { live = sourceStamp(); } catch { live = null; }
  }
  return live;
}
