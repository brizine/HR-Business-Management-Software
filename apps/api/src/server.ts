import { buildApp } from "./app";
import { startScheduler } from "./lib/jobs";
import { flushNotifications } from "./lib/notify";

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });

// Set DISABLE_SCHEDULER=true when running `pnpm jobs:run` from an external cron instead.
const timer = process.env.DISABLE_SCHEDULER === "true" ? null : startScheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await flushNotifications();
    process.exit(0);
  });
}
