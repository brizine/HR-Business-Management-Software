import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** KEY=value lines (optionally "export KEY=value", optionally quoted). Doesn't replace settings already set. */
export function loadSettingsFile(path: string): string[] {
  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    process.env[m[1]] = value;
    loaded.push(m[1]);
  }
  return loaded;
}

/**
 * Loads apps/api/.env, and the host's .env-local (SiteGround keeps it a few folders above the code)
 * if the settings weren't passed to the process. `apiDir` is the apps/api folder.
 */
export function loadSettings(apiDir: string) {
  const candidates = [resolve(apiDir, ".env")];
  // SiteGround keeps the settings in .nodeapp/.env-local, a few folders above the code.
  if (!process.env.DATABASE_URL) {
    for (const start of [process.cwd(), apiDir]) {
      let dir = start;
      for (let i = 0; i < 5; i++) { candidates.push(resolve(dir, ".env-local")); dir = dirname(dir); }
    }
  }
  for (const file of new Set(candidates)) {
    if (!existsSync(file)) continue;
    try {
      const names = loadSettingsFile(file);
      if (names.length) console.log(`Loaded ${names.join(", ")} from ${file}`);
    } catch (e) {
      console.warn(`Couldn't read ${file}: ${(e as Error).message}`);
    }
  }
}
