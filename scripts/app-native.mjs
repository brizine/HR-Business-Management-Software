// Guards the phone app's over-the-air updates (docs/phone-app-updates.md).
//
// An update can change screens, but not the "native parts" compiled into the installed app: the
// native libraries and the settings in app.json. An update that expects native code a phone doesn't
// have would crash it. Phones only take updates published for the version they were built as, so
// the rule is: when the native parts change, the version in app.json must change too. Then the
// update waits for a new store build instead of going to phones that can't run it.
//
// apps/mobile/native-parts.json records the native parts of the current version.
//   node scripts/app-native.mjs            checks the code against the record (part of typecheck)
//   node scripts/app-native.mjs --record   rewrites the record, after the version was raised
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/mobile");
const recordFile = join(app, "native-parts.json");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Finds an installed package the way Node does: beside the package that needs it, then each folder above. */
function find(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const at = join(dir, "node_modules", name);
    if (existsSync(join(at, "package.json"))) return realpathSync(at);
    if (dir === dirname(dir)) return null;
  }
}

/** What marks a package as having native code, or as changing the native project when the app is built. */
const MARKS = ["android", "ios", "expo-module.config.json", "react-native.config.js", "app.plugin.js"];

/** Every native package the app pulls in, directly or through another package, with its installed version. */
function nativePackages() {
  const seen = new Set();
  const found = {};
  const walk = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = read(join(dir, "package.json"));
    if (dir !== app && MARKS.some((mark) => existsSync(join(dir, mark)))) (found[pkg.name] ??= new Set()).add(pkg.version);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const at = find(name, dir);
      if (at) walk(at);
    }
  };
  walk(realpathSync(app));
  return Object.fromEntries(Object.keys(found).sort().map((name) => [name, [...found[name]].sort().join(" + ")]));
}

const sortKeys = (value) =>
  Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]))
  : value;

function now() {
  const { version, ...settings } = read(join(app, "app.json")).expo;
  return {
    version,
    // Every setting but the version: permissions, plugins, the icon and so on are all built in.
    settings: createHash("sha256").update(JSON.stringify(sortKeys(settings))).digest("hex").slice(0, 16),
    packages: nativePackages(),
  };
}

/** One line per difference, for the message. */
function differences(was, is) {
  const lines = [];
  if (was.settings !== is.settings) lines.push('  ~ apps/mobile/app.json (a setting other than "version")');
  for (const name of [...new Set([...Object.keys(was.packages), ...Object.keys(is.packages)])].sort()) {
    const a = was.packages[name], b = is.packages[name];
    if (a === b) continue;
    lines.push(!a ? `  + ${name} ${b}` : !b ? `  - ${name} ${a}` : `  ~ ${name} ${a} → ${b}`);
  }
  return lines;
}

const record = existsSync(recordFile) ? read(recordFile) : null;
const current = now();
const changed = record ? differences(record, current) : [];
const sameVersion = record?.version === current.version;

if (record && changed.length && sameVersion) {
  console.error(`
✖ The phone app's native parts changed, but its version is still ${current.version}:

${changed.join("\n")}

Phones take over-the-air updates only for the version they were built as, and an update that
expects native code the installed app doesn't have would crash it. So either:

  • undo the change, if it wasn't meant (for example a dependency that moved by accident), or
  • 1. raise "version" in apps/mobile/app.json (for example 1.1.0 → 1.2.0),
    2. run: node scripts/app-native.mjs --record
    3. commit both files, and tell the owner that a new store build is needed: phones keep the
       screens they have, and get no more updates, until they install it
       (docs/phone-app-updates.md).
`);
  process.exit(1);
}

if (process.argv.includes("--record")) {
  writeFileSync(recordFile, JSON.stringify({ about: "The parts of the phone app that only a store build can change, as of this version. Written by scripts/app-native.mjs; don't edit by hand.", ...current }, null, 2) + "\n");
  console.log(`✓ Recorded the phone app's native parts for version ${current.version} (${Object.keys(current.packages).length} native packages).`);
} else if (!record || !sameVersion) {
  console.error(`
✖ apps/mobile/native-parts.json ${record ? `is for version ${record.version}, and app.json says ${current.version}` : "is missing"}.
  Run: node scripts/app-native.mjs --record   and commit the file.${record ? `
  A new version needs a new store build: phones on ${record.version} get no more updates until they install it.` : ""}
`);
  process.exit(1);
} else {
  console.log(`✓ The phone app's native parts match version ${current.version}: updates are safe to send.`);
}
