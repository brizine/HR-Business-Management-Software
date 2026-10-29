/** Runs the scheduled checks once, for hosts that prefer an external cron over the in-process timer. */
import { pool } from "./db";
import { runScheduledChecks } from "./lib/jobs";
import { flushNotifications } from "./lib/notify";

const result = await runScheduledChecks();
await flushNotifications();
console.log(`Scheduled checks done: ${result.sent} alert(s) sent`);
await pool.end();
