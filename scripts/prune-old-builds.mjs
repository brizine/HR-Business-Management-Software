#!/usr/bin/env node
/**
 * SiteGround keeps every deploy as a full copy in .nodeapp/<build-id>/ (about 58,000 files each,
 * mostly node_modules), which quickly uses up the hosting plan's file ("inode") limit.
 *
 * Run at the end of a successful build: removes older build folders, keeping the one being built
 * now and the one currently live (what .nodeapp/latest points to), so a failed deploy still has
 * the previous version to fall back on. Does nothing anywhere else (your computer, CI).
 *   node scripts/prune-old-builds.mjs            remove them
 *   node scripts/prune-old-builds.mjs --dry-run  only list what it would remove
 */
import { existsSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const appSource = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? process.cwd());
const build = dirname(appSource);
const nodeapp = dirname(build);
const BUILD_ID = /^\d{9,}-[a-z0-9]+$/i;

if (basename(appSource) !== "app_source" || basename(nodeapp) !== ".nodeapp" || !BUILD_ID.test(basename(build))) {
  console.log("Not a SiteGround build folder; nothing to clean up.");
  process.exit(0);
}

// Never fail the build over clean-up.
try {
  prune();
} catch (e) {
  console.log(`Skipped cleaning up old builds: ${e.message}`);
}

function prune() {
  const keep = new Set([basename(build)]);
  const latest = resolve(nodeapp, "latest");
  if (existsSync(latest)) {
    try { keep.add(basename(resolve(nodeapp, readlinkSync(latest)))); } catch { /* not a link */ }
  }

  // Only builds older than this one (the id starts with when it was made), never one being built now.
  const stamp = (name) => Number(name.split("-")[0]);
  const old = readdirSync(nodeapp).filter((name) => BUILD_ID.test(name) && !keep.has(name) && stamp(name) < stamp(basename(build)) && statSync(resolve(nodeapp, name)).isDirectory());
  if (!old.length) {
    console.log(`No old builds to remove (keeping ${[...keep].join(", ")}).`);
    return;
  }
  for (const name of old) {
    if (dryRun) console.log(`Would remove old build ${name}`);
    else {
      try {
        rmSync(resolve(nodeapp, name), { recursive: true, force: true });
        console.log(`Removed old build ${name}`);
      } catch (e) {
        console.log(`Couldn't remove ${name}: ${e.message}`);
      }
    }
  }
  console.log(`Kept ${[...keep].join(" and ")}.`);
}
