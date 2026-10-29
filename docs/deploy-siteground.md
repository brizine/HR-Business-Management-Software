# Deploying Biz Management Software on SiteGround

Biz Management Software runs on SiteGround as **one Node.js app** that serves both the website and the API (under
`/api`) on one domain, plus a **PostgreSQL** database. SiteGround builds it from GitHub and redeploys
automatically.

```
https://app.prospray.biz          → website (staff, managers, QR scan pages, careers page)
https://app.prospray.biz/api/...  → API (used by the website and the phone app)
```

Plan for about 30–45 minutes the first time.

## 0. What you need

- ProSpray's **GoGeek** plan (up to 10 Node.js projects; Biz Management Software uses one).
- The address **`app.prospray.biz`**. The main website at `prospray.biz` is untouched. QR labels
  point to this address, so print them after it's live.
- Admin access to the GitHub repo `brizine/HR-Business-Management-Software`.

## 1. Add the domain

In **Site Tools → Domain → Subdomains** (for the prospray.biz site) create the subdomain `app`,
and make sure **Security → SSL Manager** has a Let's Encrypt certificate for it. Biz Management Software must be
served over HTTPS: phones and camera scanning need it.

## 2. Create the database

**Site Tools → Site → PostgreSQL**:

1. Create a database (e.g. `crewdesk`) and a user with a strong password, and give the user all
   privileges on the database.
2. Note the host shown there (normally `localhost`), the database name and the user.

Your `DATABASE_URL` will be:

```
postgres://USER:PASSWORD@localhost:5432/DATABASE
```

If the password contains characters like `@`, `:` or `/`, URL-encode them (`@` → `%40`).

Biz Management Software creates and updates its tables automatically every time it starts, so there's nothing to
import.

## 3. Create a mailbox for sending email

**Site Tools → Email → Accounts**: create `no-reply@prospray.biz`. Open its **Mail Configuration**
to see the outgoing (SMTP) server and port. Then:

```
SMTP_URL=smtps://no-reply%40prospray.biz:MAILBOX_PASSWORD@SMTP_SERVER:465
EMAIL_FROM="Biz Management Software <no-reply@prospray.biz>"
```

Use the server name and port SiteGround shows. With port 587, use `smtp://` instead of `smtps://`.

## 4. Choose where uploaded documents live

Pick one:

- **Simplest:** a folder in your SiteGround account outside the app's code, e.g.
  `/home/customer/crewdesk-uploads` (use the File Manager to find your account's real home path). Set
  `UPLOAD_DIR` to that absolute path. Include the folder in your backups.
- **Sturdier:** a Cloudflare R2 bucket (free up to 10 GB). Create a bucket and an API token with
  read/write access to it, then set `S3_BUCKET`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`,
  `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

Don't leave `UPLOAD_DIR` at its default (`./uploads`), because that's inside the deployed code and may be
replaced on redeploy.

## 5. Create the Node.js project

**Site Tools → Node.js** (it may be under **Devs**) → create a project for your Biz Management Software domain:

| Setting | Value |
| --- | --- |
| Source | GitHub: connect your account and pick `brizine/HR-Business-Management-Software` |
| Branch | `production` (updated automatically when tests pass; see below), or `main` |
| Node.js version | 22 (or newer) |
| Package manager | pnpm |
| Framework preset | None / Custom Node.js |
| Build command | `pnpm build` |
| Start command (if asked) | `pnpm start` |

**Environment variables** (set them in the project's settings, not in a file):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | From step 2 |
| `JWT_SECRET` | A long random string (e.g. 64 random letters/numbers). Keep it secret. |
| `ENCRYPTION_KEY` | Another long random string. Encrypts uploaded documents and two-factor secrets. **Never change it after launch, and keep a copy offline** (see step 9): without it, uploaded documents can't be opened |
| `JOBS_SECRET` | Another long random string (used by the cron job in step 7) |
| `WEB_URL` | `https://app.prospray.biz` |
| `PUBLIC_API_URL` | `https://app.prospray.biz/api` |
| `CORS_ORIGINS` | `https://app.prospray.biz` |
| `UPLOAD_DIR` *or* `S3_*` | From step 4 |
| `BACKUP_PUBLIC_KEY`, `BACKUP_DIR` | From step 9 |
| `SMTP_URL`, `EMAIL_FROM` | From step 3 |
| `TWILIO_*` | Optional, for text messages (see README) |

Don't set `PORT`; SiteGround provides it. Deploy, and watch the deployment log until the build
finishes.

**About the `production` branch:** the repo's GitHub Action runs all tests on every push to `main`
and, if they pass, moves `production` forward to that commit. Deploying from `production` means a
broken commit never reaches the live site. Until the Action has run once, `production` won't exist:
push any commit to `main`, or deploy from `main` at first and switch later.

## 6. Check it and create your account

1. Open `https://app.prospray.biz/api/health`. It should say `{"ok":true}`.
2. Open `https://app.prospray.biz/signup` and create your company and owner login.
3. **Sign-up then closes automatically.** Add everyone else from **Team → Add employee** (give them
   a password, or let them use email/text notifications only).
4. **Two-factor:** owners and admins must use an authenticator app. The next time you sign in you'll
   be walked through setup; save the backup codes it shows. Change who must use it under
   **Settings → Security**.
5. Test **Forgot your password?** on the sign-in page once email is set up, so you know reset emails arrive.

## 7. Add the scheduled-checks cron job

Biz Management Software checks every 15 minutes for maintenance coming due, expiring registrations, forgotten
clock-outs and upcoming shifts. It does this inside the app, but in case SiteGround restarts or
pauses the app, also add **Site Tools → Devs → Cron Jobs**, every 15 minutes:

```
curl -s -X POST -H "X-Jobs-Secret: YOUR_JOBS_SECRET" https://app.prospray.biz/api/jobs/run > /dev/null
```

Running it twice is harmless; each alert is only sent once.

## 8. Phone app

Push notifications and the camera scanner need the Biz Management Software app built for your server:

1. `apps/mobile/eas.json` already points the app at `https://app.prospray.biz/api`.
2. Follow **Enabling push on phones** in the README (`eas init`, `eas build`).
3. To put it in the App Store and Google Play you need an Apple Developer account ($99/year) and a
   Google Play developer account ($25 once). `eas submit` uploads the builds.

Everything except push and the in-app scanner also works in the phone's browser at your Biz Management Software
address. QR labels open in the browser without the app.

## 9. Encrypted backups

Biz Management Software makes a nightly, encrypted copy of the database. Backups are locked with a **public key**;
only the matching **private key**, which never goes on the server, can open them. So a leaked backup,
or even a broken-into server, doesn't expose old backups.

**a. Make the key pair on your own computer** (Mac: Terminal; Windows: Git Bash). Choose a strong
passphrase when asked:

```
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -aes256 -out crewdesk-backup-private-key.pem
openssl pkey -in crewdesk-backup-private-key.pem -pubout -outform DER | base64 | tr -d '\n'; echo
```

The second command prints one long line: that's the **public key**.

**b. Store the private key and its passphrase offline**, e.g. in your password manager plus a printed
copy in the office safe. Store `ENCRYPTION_KEY` the same way: you'd need it to open uploaded
documents after a full restore. Nobody, including SiteGround, can recover these for you.

**c. Add to the Node.js project's environment variables:**

| Name | Value |
| --- | --- |
| `BACKUP_PUBLIC_KEY` | The long line from step a |
| `BACKUP_DIR` | A folder outside the app's code, e.g. `/home/customer/crewdesk-backups` (or use the R2 bucket from step 4; backups then go under `backups/`) |

**d. Add a nightly cron job** (Devs → Cron Jobs, e.g. 2:15 AM):

```
curl -s -X POST -H "X-Jobs-Secret: YOUR_JOBS_SECRET" https://app.prospray.biz/api/jobs/backup > /dev/null
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

## Troubleshooting

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
