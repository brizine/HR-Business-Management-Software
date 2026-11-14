# Deploying Crewdesk on SiteGround

Crewdesk runs on SiteGround as **one Node.js app** that serves both the website and the API (under
`/api`) on one domain, plus a **PostgreSQL** database. SiteGround builds it from GitHub and redeploys
automatically.

```
https://management.prospray.net          → website (staff, managers, QR scan pages, careers page)
https://management.prospray.net/api/...  → API (used by the website and the phone app)
```

Plan for about 45 minutes the first time. SiteGround's Node.js screens are new, so a few labels may
differ slightly from these steps.

## 0. What you need

- ProSpray's **GoGeek** plan (Node.js projects need GrowBig or GoGeek; GoGeek allows up to 10).
- The address **`management.prospray.net`**. The main website at `prospray.net` is untouched. QR labels
  point to this address, so print them after it's live.
- Admin access to the GitHub repo `brizine/HR-Business-Management-Software`.
- **Three secrets.** On any Mac (Terminal), run this three times and keep the results in your
  password manager. They become `JWT_SECRET`, `ENCRYPTION_KEY` and `JOBS_SECRET` in step 6:
  ```
  openssl rand -hex 32
  ```
  **Never lose or change `ENCRYPTION_KEY`:** uploaded documents can't be opened without it. Keep a
  printed copy somewhere safe too.

## 1. Create the Node.js project

A Node.js app is **its own project** on SiteGround, not a menu inside an existing website's Site
Tools:

1. Log in to SiteGround, click **Websites** at the top, open the **Node.js Projects** tab and click
   **New Project**.
2. Choose **Import from GitHub** (not the ZIP upload), connect your GitHub account and pick
   `brizine/HR-Business-Management-Software`, branch **`production`**. With GitHub, every update to
   that branch redeploys the app automatically.
3. The project starts on a free temporary web address. That's fine: you'll attach `management.prospray.net`
   in step 7.

**About the `production` branch:** the repo's GitHub Action runs all tests on every push to `main`
and, if they pass, moves `production` forward to that commit. Deploying from `production` means a
broken commit never reaches the live site.

## 2. Build settings

Open the project's **own Site Tools** (Websites → Node.js Projects → your project → **Site Tools**).
Everything from here on, until step 5, happens in this project's Site Tools. Under **Node.js**, set:

| Setting | Value |
| --- | --- |
| Node.js version | 22 (or newer) |
| Package manager | pnpm |
| Framework preset | None / Custom Node.js |
| Build command | `pnpm build` |
| Start command (if asked) | `pnpm start` |

SiteGround usually has no start-command field; it runs `npm start` by itself, which starts Crewdesk.

## 3. Create the database

In the project's Site Tools: **Site → PostgreSQL**.

1. Create a database (e.g. `crewdesk`) and a user with a strong password, and give the user all
   privileges on the database.
2. Note the host shown there (normally `localhost`), the database name and the user.

Your `DATABASE_URL` will be:

```
postgres://USER:PASSWORD@localhost:5432/DATABASE
```

If the password contains `@`, `:` or `/`, replace them with `%40`, `%3A` and `%2F`.

Crewdesk creates and updates its tables automatically every time it starts, so there's nothing to
import.

## 4. A folder for uploaded documents

Pick one:

- **Simplest:** in the project's Site Tools, open **Site → File Manager**. At the top level (where you
  see the `www` folder, **not inside it**), click **New Folder** and name it `crewdesk-uploads`.
  Outside `www`, nobody can download the files from the web and a redeploy won't erase them.
  Then set `UPLOAD_DIR` to **`~/crewdesk-uploads`**: the `~` means "this account's home folder", so
  you don't need to look up the full path. When Crewdesk starts, its deployment log shows the full
  path it's using ("Uploaded documents are stored in /home/…/crewdesk-uploads"): check that it's
  the folder you made. Include this folder in your backups.
- **Sturdier:** a Cloudflare R2 bucket (free up to 10 GB). Create a bucket and an API token with
  read/write access to it, then set `S3_BUCKET`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`,
  `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

Don't leave `UPLOAD_DIR` at its default (`./uploads`): that's inside the deployed code and may be
replaced on redeploy.

## 5. A mailbox for sending email

Use a mailbox on a domain whose email SiteGround hosts, e.g. `no-reply@prospraylawns.com`. In **that
website's** Site Tools: **Email → Accounts**, create the mailbox, then open its **Mail Configuration**
to see the outgoing (SMTP) server and port. Then:

```
SMTP_URL=smtps://no-reply%40prospraylawns.com:MAILBOX_PASSWORD@SMTP_SERVER:465
EMAIL_FROM="Crewdesk <no-reply@prospraylawns.com>"
```

Use the server name and port SiteGround shows. With port 587, use `smtp://` instead of `smtps://`.
(SiteGround doesn't block email ports, unlike some cloud servers.)

## 6. Environment variables, then deploy

Back in the **project's** Site Tools → **Node.js**, add these environment variables (in the project's
settings, not in a file):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | From step 3 |
| `JWT_SECRET` | Secret 1 from step 0 |
| `ENCRYPTION_KEY` | Secret 2 from step 0. Encrypts uploaded documents and two-factor secrets. **Never change it after launch, and keep a copy offline** (see step 12) |
| `JOBS_SECRET` | Secret 3 from step 0 (used by the cron job in step 9) |
| `WEB_URL` | `https://management.prospray.net` |
| `PUBLIC_API_URL` | `https://management.prospray.net/api` |
| `CORS_ORIGINS` | `https://management.prospray.net` |
| `UPLOAD_DIR` *or* `S3_*` | From step 4 |
| `SMTP_URL`, `EMAIL_FROM` | From step 5 |
| `BACKUP_PUBLIC_KEY`, `BACKUP_DIR` | From step 12 (can be added later) |
| `TWILIO_*` | Optional, for text messages (see README) |

Don't set `PORT`; SiteGround provides it. Deploy, and watch the **deployment log** until the build
finishes.

## 7. Attach management.prospray.net

In the project's Site Tools, look under **Domain** for adding (or parking) a domain, and connect
`management.prospray.net`. Then check **Security → SSL Manager** has a Let's Encrypt certificate for it:
Crewdesk must be served over HTTPS (phones and camera scanning need it).

If you already created `management` as a subdomain under the prospray.net website, delete it there first,
or the two may conflict. If prospray.net's DNS isn't at SiteGround, point `management` at the address
SiteGround shows for the project.

## 8. Check it and create your account

1. Open `https://management.prospray.net/api/health`. It should say `{"ok":true}`.
2. Open `https://management.prospray.net/signup` and create your company and owner login.
3. **Sign-up then closes automatically.** Add everyone else from **Team → Add employee** (give them
   a password, or let them use email/text notifications only).
4. **Two-factor:** owners and admins get a 6-digit code by email each time they sign in, so email
   (step 5) must work. Anyone can switch to an authenticator app under **Settings → Security**, and
   the owner chooses who must use two-factor there. If email isn't working, people without the app
   are walked through setting it up instead.
5. Test **Forgot your password?** on the sign-in page once email is set up, so you know reset emails arrive.

## 9. Add the scheduled-checks cron job

Crewdesk checks every 5 minutes for people who haven't clocked in for their shift, attendance point
levels, maintenance coming due, expiring registrations, forgotten clock-outs, upcoming shifts, training
due dates and pay periods that have ended. It does this inside the app, but in case SiteGround restarts
or pauses the app, also add **Site Tools → Devs → Cron Jobs**, every 5 minutes (or the shortest
interval SiteGround offers):

```
curl -s -X POST -H "X-Jobs-Secret: YOUR_JOBS_SECRET" https://management.prospray.net/api/jobs/run > /dev/null
```

Running it twice is harmless; each alert is only sent once.

## 10. Connect your accounting (optional)

If you run Bigcapital (see `deploy/bigcapital/README.md`), open **Accounting** in Crewdesk's sidebar,
enter its address (e.g. `https://books.prospray.net`) and an API key from Bigcapital
(**Preferences → API keys**), test the connection and choose accounts. Approved pay periods and
completed work orders can then be sent to your books.

## 11. Phone app

Push notifications and the camera scanner need the Crewdesk app built for your server:

1. `apps/mobile/eas.json` already points the app at `https://management.prospray.net/api`.
2. Follow **Enabling push on phones** in the README (`eas init`, `eas build`).
3. To put it in the App Store and Google Play you need an Apple Developer account ($99/year) and a
   Google Play developer account ($25 once). `eas submit` uploads the builds.

Everything except push and the in-app scanner also works in the phone's browser at your Crewdesk
address. QR labels open in the browser without the app.

## 12. Encrypted backups

Crewdesk makes a nightly, encrypted copy of the database. Backups are locked with a **public key**;
only the matching **private key**, which never goes on the server, can open them. So a leaked backup,
or even a broken-into server, doesn't expose old backups.

**a. Make the key pair on your own computer** (the Mac that stays in the office). In Terminal, in
your Crewdesk folder (run `git pull` first so you have the script):

```
node scripts/backup-keygen.mjs
```

It asks for a passphrase twice (nothing shows while you type), saves the private key as
`crewdesk-backup-private-key.pem` in that folder, and prints the **public key**: one short line,
about 60 characters. It needs only Node.js, no install or build.

**b. Store the private key and its passphrase offline**, e.g. in your password manager plus a printed
copy in the office safe. Store `ENCRYPTION_KEY` the same way: you'd need it to open uploaded
documents after a full restore. Nobody, including SiteGround, can recover these for you.

**c. Add to the Node.js project's environment variables:**

| Name | Value |
| --- | --- |
| `BACKUP_PUBLIC_KEY` | The line from step a |
| `BACKUP_DIR` | A folder outside the app's code, e.g. `~/crewdesk-backups` (made the same way as the uploads folder in step 4) (or use the R2 bucket from step 4; backups then go under `backups/`) |

**d. Add a nightly cron job** (Devs → Cron Jobs, e.g. 2:15 AM):

```
curl -s -X POST -H "X-Jobs-Secret: YOUR_JOBS_SECRET" https://management.prospray.net/api/jobs/backup > /dev/null
```

The newest 30 backups are kept (`BACKUP_KEEP` changes that). Run it once by hand and check that a
`crewdesk-….dump.enc` file appears. If it says `pg_dump` isn't found, ask SiteGround support for its
path and set `PG_DUMP_PATH`.

**Restoring** (on a computer with Node 22 and this repo, after `pnpm install && pnpm build`):

```
pnpm backup:decrypt crewdesk-2026-11-02T07-15-00.dump.enc crewdesk-backup-private-key.pem
pg_restore --no-owner -d "postgres://USER:PASSWORD@HOST:5432/NEW_DATABASE" crewdesk-2026-11-02T07-15-00.dump
```

Uploaded documents are already encrypted, so the upload folder (or bucket) can be backed up as-is,
e.g. by SiteGround's own backups. Restoring them needs the same `ENCRYPTION_KEY`.

## 13. Help assistant (optional)

The **Help** item in the sidebar answers "how do I…" questions about Crewdesk with an AI assistant
(Anthropic's Claude), using `docs/help-guide.md` as its source. To turn it on:

1. Create an API key at **console.anthropic.com** (Settings → API Keys) and add a payment method or
   credits there. Consider setting a monthly spend limit in the Console.
2. In the Node.js project's **Environment variables**, add `ANTHROPIC_API_KEY` with that key, then
   **Save and deploy**.

Each question costs roughly a cent or two (the guide is cached between questions). Up to 60 questions an
hour can come from one internet connection (`HELP_RATE_LIMIT` changes that). The assistant only sees the guide,
the question and the person's name and role, never company records. Keep `docs/help-guide.md`
up to date when features change.

## Troubleshooting

- **"Exceeded 90% of the inode quota" email**: SiteGround keeps every deploy as a full copy of the app
  (about 58,000 files each, mostly `node_modules`) in `.nodeapp/<build>/`. The build now removes old
  copies at the end of each deploy (`scripts/prune-old-builds.mjs`), keeping only the live one and the
  new one, so a **Redeploy** clears the backlog. To see the counts over SSH:
  `for b in ~/www/*/public_html/.nodeapp/*/; do printf '%7d %s\n' "$(find "$b" | wc -l)" "$b"; done`

- **502 Bad Gateway**: the website is up but Crewdesk didn't start. SiteGround doesn't show what a
  running app prints, so Crewdesk writes it to a file: in **Site Tools → Site → File Manager**, open
  your home folder (the one that holds `crewdesk-uploads`) and open **`crewdesk-startup.log`**. The
  last block shows how far it got, and lines starting with **✖** say what to fix. A copy is also
  written to `www/<your domain>/public_html/.nodeapp/latest/app_source/crewdesk-startup.log`. If
  neither file exists, Crewdesk never started: check **Site Tools → Statistics → Error Log**, and
  check that **Node.js → Logs** shows the newest deploy as completed. The log holds
  setting names only, never passwords, and you can put it elsewhere with `LOG_FILE`.
- **The build fails**: open the deployment log in Site Tools → Node.js. Make sure the package manager
  is pnpm and the Node version is 22+.
- **"No web build found"**: the build command didn't run `pnpm build`.
- **The app starts then stops, mentioning `JWT_SECRET`**: set it in the environment variables.
- **Database connection errors**: double-check `DATABASE_URL`, especially URL-encoding of the
  password, and that the user has privileges on the database.
- **"needs the pgcrypto extension"**: SiteGround's PostgreSQL is older than version 13; ask support to
  enable the `pgcrypto` extension on your database.
- **Emails don't arrive**: confirm the mailbox password and SMTP server, and check that SPF/DKIM are
  enabled for the domain in **Site Tools → Email → Authentication**.

If SiteGround's Node.js hosting doesn't work out, the same `pnpm build` / `pnpm start` commands
run on Render, Railway or Fly.io with a managed PostgreSQL.
