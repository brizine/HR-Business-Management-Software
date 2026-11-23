// Starts the built server the way production does and checks that it answers. Tests import the
// source, so a problem that only shows in the bundle (such as an import cycle) would otherwise
// reach the live site. Exits non-zero if the server stops or doesn't answer within 60 seconds.
import { spawn } from "node:child_process";

const port = process.env.SMOKE_PORT ?? "3998";
const child = spawn(process.execPath, ["apps/api/dist/start.js"], {
  env: { ...process.env, PORT: port, DISABLE_SCHEDULER: "true" },
  stdio: ["ignore", "inherit", "inherit"],
});
let exited = null;
child.on("exit", (code) => { exited = code ?? 1; });

const deadline = Date.now() + 60_000;
let ok = false;
while (Date.now() < deadline && exited === null) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) { ok = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 1000));
}
child.kill();
if (!ok) {
  console.error(exited !== null ? `✖ The built server stopped while starting (exit ${exited}).` : "✖ The built server didn't answer /api/health within 60 seconds.");
  process.exit(1);
}
console.log("✓ The built server starts and answers /api/health.");
process.exit(0);
