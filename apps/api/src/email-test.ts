/**
 * Sends a test email with Crewdesk's own email settings and explains any problem in plain words.
 *   node apps/api/dist/email-test.js you@example.com
 * Prints the settings with the password hidden; never prints the password.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { loadSettings } from "./lib/settings-file";

loadSettings(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const to = process.argv[2];
const raw = process.env.SMTP_URL?.trim();
const from = process.env.EMAIL_FROM ?? "Crewdesk <no-reply@example.com>";

function fail(message: string, hint?: string): never {
  console.error(`\n✖ ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

if (!to || !to.includes("@")) fail("Say where to send the test, e.g.:  node apps/api/dist/email-test.js you@example.com");
if (!raw) fail("SMTP_URL isn't set.", "Add it under the project's environment variables (see step 5 of the guide), then Save and deploy.");

let url: URL;
try {
  url = new URL(raw);
} catch {
  fail("SMTP_URL isn't a valid address.", "It should look like smtps://USER:PASSWORD@SERVER:465. In the username and password, write @ as %40, : as %3A, / as %2F, # as %23, ? as %3F and % as %25.");
}
const user = decodeURIComponent(url.username);
const shown = `${url.protocol}//${url.username}${url.password ? ":••••••" : ""}@${url.host}`;
console.log(`SMTP_URL:   ${shown}`);
console.log(`EMAIL_FROM: ${from}`);
console.log(`Sending to: ${to}\n`);

const port = Number(url.port || (url.protocol === "smtps:" ? 465 : 587));
if (url.protocol !== "smtps:" && url.protocol !== "smtp:") fail(`SMTP_URL starts with "${url.protocol}//".`, "Use smtps:// with port 465, or smtp:// with port 587.");
if (url.protocol === "smtps:" && port === 587) fail("smtps:// with port 587 won't work.", "Use smtp:// with port 587, or smtps:// with port 465.");
if (url.protocol === "smtp:" && port === 465) fail("smtp:// with port 465 won't work.", "Use smtps:// with port 465, or smtp:// with port 587.");
if (!user || !url.password) fail("SMTP_URL has no username or password.", "It should look like smtps://no-reply%40yourdomain.com:PASSWORD@SERVER:465 (the username is the full email address, with @ written as %40).");
if (!user.includes("@")) console.warn(`⚠ The username "${user}" isn't a full email address. SiteGround mailboxes sign in with the whole address (written with %40 for @).\n`);
const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from;
if (/^["']|["']$/.test(from)) console.warn("⚠ EMAIL_FROM has quote marks around it. Enter it without quotes: Crewdesk <no-reply@yourdomain.com>\n");
if (user.includes("@") && fromAddress.toLowerCase() !== user.toLowerCase()) {
  console.warn(`⚠ EMAIL_FROM (${fromAddress}) isn't the mailbox you sign in with (${user}). Many mail servers refuse that; use the same address.\n`);
}

const transport = nodemailer.createTransport(raw, { connectionTimeout: 15_000, greetingTimeout: 15_000 } as never);

console.log(`Connecting to ${url.hostname}:${port}…`);
try {
  await transport.verify();
  console.log("Connected and signed in to the mailbox.");
  const info = await transport.sendMail({
    from,
    to,
    subject: "Crewdesk test email",
    text: "This is a test from Crewdesk. If you're reading it, sign-in codes and notifications can be emailed.",
  });
  console.log(`\n✔ Sent (${info.response}). Check ${to}, including the spam folder.\n`);
  process.exit(0);
} catch (err) {
  const e = err as NodeJS.ErrnoException & { responseCode?: number; response?: string; command?: string };
  const detail = e.response ?? e.message;
  console.error(`  (${e.code ?? "error"}: ${detail})`);
  const all = `${e.code ?? ""} ${detail}`;
  if (e.code === "EAUTH") fail("The mailbox refused the username or password.", `Check the password for ${user} (Email → Accounts in the site where the mailbox lives lets you change it). Use letters and numbers only, or write symbols as %40 %3A %2F %23 %3F %25.`);
  if (/ENOTFOUND|EDNS|EAI_AGAIN/.test(all)) fail(`The server name "${url.hostname}" doesn't exist.`, "Copy the outgoing (SMTP) server exactly from the mailbox's Mail Configuration in SiteGround.");
  if (/ECONNREFUSED/.test(all)) fail(`Nothing answered at ${url.hostname}:${port}.`, "Check the server name and port from the mailbox's Mail Configuration (465 with smtps://, or 587 with smtp://).");
  if (/ETIMEDOUT|timeout|timed out/i.test(all)) fail(`${url.hostname}:${port} didn't answer in time.`, "The port may be blocked or wrong. Try smtps:// with port 465, or smtp:// with port 587.");
  if (/certificate|altname|self.signed|CERT_/i.test(all)) fail("The mail server's security certificate doesn't match that server name.", "Use the server name SiteGround shows under the mailbox's Mail Configuration (often like gtxm1363.siteground.biz) instead of mail.yourdomain.com.");
  if (/wrong version number|ssl3_get_record|packet length/i.test(detail)) fail("The connection type doesn't match the port.", "Use smtps:// with port 465, or smtp:// with port 587.");
  if (e.responseCode && e.responseCode >= 500 && e.command && /MAIL|RCPT/.test(e.command)) fail("The server refused to send this message.", `Usually EMAIL_FROM isn't the mailbox you sign in with. Set EMAIL_FROM to: Crewdesk <${user}>`);
  fail("Sending failed.", "Paste the line in brackets above, without any password, and we'll work out what it means.");
}
