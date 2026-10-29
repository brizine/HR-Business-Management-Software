# Deploying Crewdesk on SiteGround

Crewdesk runs on SiteGround as **one Node.js app** that serves both the website and the API (under
`/api`) on one domain, plus a **PostgreSQL** database. SiteGround builds it from GitHub and redeploys
automatically.

```
https://crewdesk.yourcompany.com          → website (staff, managers, QR scan pages, careers page)
https://crewdesk.yourcompany.com/api/...  → API (used by the website and the phone app)
```

Plan for about 30–45 minutes the first time.

## 0. What you need

- A SiteGround **GrowBig, GoGeek or Cloud** plan. StartUp can't run Node.js apps. Crewdesk uses one
  Node.js project slot.
- A domain or subdomain for it, e.g. `crewdesk.yourcompany.com`. Decide this **before printing QR
  labels**, because labels point to it.
- Admin access to the GitHub repo `brizine/HR-Business-Management-Software`.

## 1. Add the domain

In **Site Tools → Domain → Subdomains** create `crewdesk` (or add a new site for a separate domain),
and make sure **Security → SSL Manager** has a Let's Encrypt certificate for it. Crewdesk must be
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

Crewdesk creates and updates its tables automatically every time it starts, so there's nothing to
import.

## 3. Create a mailbox for sending email

**Site Tools → Email → Accounts**: create `no-reply@yourcompany.com`. Open its **Mail Configuration**
to see the outgoing (SMTP) server and port. Then:

```
SMTP_URL=smtps://no-reply%40yourcompany.com:MAILBOX_PASSWORD@SMTP_SERVER:465
EMAIL_FROM="Crewdesk <no-reply@yourcompany.com>"
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

**Site Tools → Node.js** (it may be under **Devs**) → create a project for your Crewdesk domain:

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
| `JOBS_SECRET` | Another long random string (used by the cron job in step 7) |
| `WEB_URL` | `https://crewdesk.yourcompany.com` |
| `PUBLIC_API_URL` | `https://crewdesk.yourcompany.com/api` |
| `CORS_ORIGINS` | `https://crewdesk.yourcompany.com` |
| `UPLOAD_DIR` *or* `S3_*` | From step 4 |
| `SMTP_URL`, `EMAIL_FROM` | From step 3 |
| `TWILIO_*` | Optional, for text messages (see README) |

Don't set `PORT`; SiteGround provides it. Deploy, and watch the deployment log until the build
finishes.

**About the `production` branch:** the repo's GitHub Action runs all tests on every push to `main`
and, if they pass, moves `production` forward to that commit. Deploying from `production` means a
broken commit never reaches the live site. Until the Action has run once, `production` won't exist:
push any commit to `main`, or deploy from `main` at first and switch later.

## 6. Check it and create your account

1. Open `https://crewdesk.yourcompany.com/api/health`. It should say `{"ok":true}`.
2. Open `https://crewdesk.yourcompany.com/signup` and create your company and owner login.
3. **Sign-up then closes automatically.** Add everyone else from **Team → Add employee** (give them
   a password, or let them use email/text notifications only).

## 7. Add the scheduled-checks cron job

Crewdesk checks every 15 minutes for maintenance coming due, expiring registrations, forgotten
clock-outs and upcoming shifts. It does this inside the app, but in case SiteGround restarts or
pauses the app, also add **Site Tools → Devs → Cron Jobs**, every 15 minutes:

```
curl -s -X POST -H "X-Jobs-Secret: YOUR_JOBS_SECRET" https://crewdesk.yourcompany.com/api/jobs/run > /dev/null
```

Running it twice is harmless; each alert is only sent once.

## 8. Phone app

Push notifications and the camera scanner need the Crewdesk app built for your server:

1. In `apps/mobile/eas.json`, replace `https://crewdesk.yourcompany.com/api` with your address.
2. Follow **Enabling push on phones** in the README (`eas init`, `eas build`).
3. To put it in the App Store and Google Play you need an Apple Developer account ($99/year) and a
   Google Play developer account ($25 once). `eas submit` uploads the builds.

Everything except push and the in-app scanner also works in the phone's browser at your Crewdesk
address. QR labels open in the browser without the app.

## 9. Backups

- SiteGround's daily backups cover your files. Ask SiteGround support whether they include
  PostgreSQL databases on your plan; if not, add a nightly cron job (adjust names and paths):

  ```
  PGPASSWORD='DB_PASSWORD' pg_dump -h localhost -U USER DATABASE | gzip > /home/customer/backups/crewdesk-$(date +\%F).sql.gz
  ```

- If uploads are in `UPLOAD_DIR`, make sure that folder is backed up too (R2 is durable on its own).

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
