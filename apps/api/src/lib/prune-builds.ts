import { existsSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const BUILD_ID = /^\d{9,}-[a-z0-9]+$/i;
const stamp = (name: string) => Number(name.split("-")[0]);

/**
 * On SiteGround, each deploy is a full copy of the app in .nodeapp/<build-id>/ (about 57,000
 * files). Once a build is running, the older ones aren't needed: remove them, keeping the running
 * build and whatever .nodeapp/latest points to. Builds newer than the running one (a deploy in
 * progress) are never touched. Does nothing outside a SiteGround build folder.
 */
export function removeOlderBuilds(appSource = process.cwd(), log: (m: string) => void = console.log) {
  try {
    const real = realpathSync(appSource);
    const build = dirname(real);
    const nodeapp = dirname(build);
    if (basename(real) !== "app_source" || basename(nodeapp) !== ".nodeapp" || !BUILD_ID.test(basename(build))) return [];
    const keep = new Set([basename(build)]);
    const latest = resolve(nodeapp, "latest");
    if (existsSync(latest)) {
      try { keep.add(basename(resolve(nodeapp, readlinkSync(latest)))); } catch { /* not a link */ }
    }
    const old = readdirSync(nodeapp).filter((n) => BUILD_ID.test(n) && !keep.has(n) && stamp(n) < stamp(basename(build)) && statSync(resolve(nodeapp, n)).isDirectory());
    for (const n of old) {
      rmSync(resolve(nodeapp, n), { recursive: true, force: true });
      log(`Removed old build ${n} (frees about 57,000 files on the hosting plan).`);
    }
    return old;
  } catch (e) {
    log(`Skipped removing old builds: ${(e as Error).message}`);
    return [];
  }
}
