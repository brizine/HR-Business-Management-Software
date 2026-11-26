// Sends the phone app's screen changes to phones over the air (docs/phone-app-updates.md).
// Run by .github/workflows/ci.yml after the tests pass on main, in three steps:
//
//   node scripts/app-update.mjs plan      is there anything new for the phones?
//   node scripts/app-update.mjs wait      wait until the website runs this same code
//   node scripts/app-update.mjs publish   send the update (needs EXPO_TOKEN)
//
// The branch `phone-app` points at the commit phones have, the way `production` points at the
// commit the website runs. The workflow moves it forward after a successful publish.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "phone-app";
/** A change anywhere else can't change what the phone app does. */
const PATHS = ["apps/mobile", "packages/shared"];
/** The publishing tool, pinned so an unattended job doesn't pick up a surprise. Raise it on purpose. */
const EAS_CLI = "eas-cli@27.11.0";
const WAIT_MINUTES = 25;

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const works = (...args) => { try { git(...args); return true; } catch { return false; } };
/** The commit a branch on GitHub points at, or null when there's no such branch. */
const remote = (branch) => git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] || null;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The address store builds use (eas.json), so an update can never point phones anywhere else. */
function apiUrl() {
  const url = JSON.parse(readFileSync(join(root, "apps/mobile/eas.json"), "utf8")).build?.production?.env?.EXPO_PUBLIC_API_URL;
  if (!/^https:\/\/[^/]+\/api$/.test(url ?? "")) throw new Error(`apps/mobile/eas.json has no usable EXPO_PUBLIC_API_URL for production builds (found ${JSON.stringify(url)}).`);
  return url;
}

async function liveBuild() {
  const res = await fetch(`${apiUrl()}/health`, { headers: { "user-agent": "crewdesk-app-update" }, signal: AbortSignal.timeout(20_000) });
  return (await res.json()).build ?? null;
}

async function thisBuild() {
  const { sourceStamp } = await import("../apps/api/src/lib/source-stamp.ts");
  return sourceStamp(root);
}

/** Tells the workflow whether to go on, and says why where a person will see it. */
function decide(publish, why) {
  console.log(`${publish ? "→" : "■"} ${why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Phone app update:** ${why}\n\n`);
}

async function plan() {
  const head = git("rev-parse", "HEAD");
  try {
    console.log(`The website is running build ${await liveBuild()}; this commit is build ${await thisBuild()}.`);
  } catch (err) {
    console.log(`Couldn't ask the website which build it runs (${err.message}).`);
  }
  if (!process.env.EXPO_TOKEN) return decide(false, "Not sent: the repository has no `EXPO_TOKEN` secret yet (docs/phone-app-updates.md).");
  const tip = remote("main");
  if (tip && tip !== head) return decide(false, "Not sent from this run: a newer commit is on main, and its run sends everything.");
  const at = remote(MARK);
  if (!at) return decide(true, "Sending: nothing has been sent to phones before.");
  if (at === head) return decide(false, "Not sent: phones already have this commit.");
  if (!works("cat-file", "-e", `${at}^{commit}`)) git("fetch", "--quiet", "origin", at);
  if (!works("merge-base", "--is-ancestor", at, head)) return decide(false, "Not sent: phones already have a newer commit.");
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") return decide(true, "Sending: asked for by hand.");
  if (works("diff", "--quiet", at, head, "--", ...PATHS)) return decide(false, "Not sent: the phone app's code hasn't changed since the last update.");
  return decide(true, "Sending: the phone app's code changed.");
}

/** Phones mustn't get screens before the server they talk to, so wait for the website's deploy. */
async function wait() {
  const head = git("rev-parse", "HEAD");
  const want = await thisBuild();
  const until = Date.now() + WAIT_MINUTES * 60_000;
  let live = null;
  while (Date.now() < until) {
    try { live = await liveBuild(); } catch { /* deploying, or a blip: ask again */ }
    if (live === want) return decide(true, `The website is running this commit (build ${want}).`);
    let tip = null;
    try { tip = remote("main"); } catch { /* GitHub didn't answer: ask again next time round */ }
    if (tip && tip !== head) return decide(false, "Not sent from this run: a newer commit reached main, and its run sends everything.");
    console.log(`Waiting for the website: it runs build ${live ?? "?"}, this commit is ${want}.`);
    await sleep(20_000);
  }
  decide(false, `Not sent: after ${WAIT_MINUTES} minutes the website still isn't running this commit (it runs build ${live ?? "unknown"}, this is ${want}). Check the website's deploy, then run this workflow by hand (Actions → CI → Run workflow).`);
  process.exit(1);
}

function publish() {
  if (!process.env.EXPO_TOKEN) throw new Error("EXPO_TOKEN isn't set.");
  const message = git("log", "-1", "--pretty=%s").slice(0, 200);
  const done = spawnSync("npx", ["--yes", EAS_CLI, "update", "--channel", "production", "--message", message, "--non-interactive"], {
    cwd: join(root, "apps/mobile"),
    stdio: "inherit",
    // Compiled into the update, exactly as into a store build.
    env: { ...process.env, EXPO_PUBLIC_API_URL: apiUrl() },
  });
  if (done.status !== 0) process.exit(done.status ?? 1);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Sent to phones: “${message}”. They get it the next time the app is opened, or from **Update** in the app.\n`);
}

const steps = { plan, wait, publish };
const step = steps[process.argv[2]];
if (!step) {
  console.error("Usage: node scripts/app-update.mjs plan | wait | publish");
  process.exit(2);
}
await step();
