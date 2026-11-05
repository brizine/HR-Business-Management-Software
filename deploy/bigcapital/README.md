# Running Bigcapital on its own server

[Bigcapital](https://github.com/bigcapitalhq/bigcapital) is open-source accounting software
(invoices, bills, banking, chart of accounts, financial reports). It runs as its own program on its
own server, separate from Crewdesk. Nothing in Crewdesk depends on it.

This folder installs it with Bigcapital's **official** Docker setup, and adds
[Caddy](https://caddyserver.com) in front so it gets a free HTTPS certificate automatically.

> **License:** Bigcapital is AGPL-3.0. Running it unmodified for your own company is fine. If you
> change its code and let others use it over the web, the AGPL requires offering them your changed
> source. These scripts don't change Bigcapital's code.

## What you need

- **A small Linux server (VPS)** running Ubuntu 22.04 or 24.04, with 4 GB of memory and 2 CPUs (8 GB if
  you'll have many users), and 40 GB+ of disk. Examples: DigitalOcean, Hetzner, Linode, or Amazon
  Lightsail, at roughly $15–25 a month. SiteGround shared hosting can't run it (no Docker).
- **A web address** for it, e.g. `books.prospray.biz`. You can keep the domain at SiteGround.
- **The email address** you'll sign up with. Only this address can create an account; you invite
  everyone else from inside Bigcapital.
- **(Optional) An outgoing email account (SMTP)** so Bigcapital can send invoices and invitations,
  e.g. your Google Workspace/Microsoft 365 mailbox, SendGrid or Mailgun. You can add it later.

## Step by step

1. **Create the server.** Pick Ubuntu 24.04 with 4 GB of memory. Note its IP address.
2. **Point the web address at it.** In SiteGround: *Site Tools → Domain → DNS Zone Editor*, add an
   **A record**: name `books`, value the server's IP address. It can take a few minutes to an hour
   to take effect.
3. **Open the firewall** for web traffic (most providers allow it by default; if yours has a
   firewall panel, allow ports **80** and **443**, and **22** for SSH).
4. **Log in to the server** (`ssh root@your-server-ip`) and get this folder onto it:
   ```bash
   apt-get update && apt-get install -y git
   git clone https://github.com/<your-account>/hr-business-management-software.git
   cd hr-business-management-software/deploy/bigcapital
   ```
   (or copy just this folder over with `scp -r deploy/bigcapital root@your-server-ip:`).
5. **Run the installer** with your web address and email:
   ```bash
   sudo ./install.sh --domain books.prospray.biz --admin-email you@prospray.biz
   ```
   To add outgoing email now, add for example
   `--smtp-host smtp.gmail.com --smtp-port 587 --smtp-user you@prospray.biz --smtp-pass 'app-password'`.

   It takes about 5–10 minutes. It installs Docker if needed, downloads Bigcapital's official setup,
   creates strong passwords, starts everything, sets up file storage, and starts HTTPS.
6. **Open `https://books.prospray.biz`** and sign up with the email you gave. Then set up your
   company, chart of accounts and opening balances, and invite your bookkeeper or accountant.

## Everyday use

From the install folder (`/opt/bigcapital`):

| Command | What it does |
| --- | --- |
| `./bigcapital.sh status` | Shows whether everything is running |
| `./bigcapital.sh logs` / `logs server` | Shows recent logs (Ctrl+C to stop) |
| `./bigcapital.sh restart` | Restarts Bigcapital |
| `./bigcapital.sh stop` / `start` | Stops / starts it |
| `./bigcapital.sh upgrade` | Gets the newest version and updates the database |
| `./bigcapital.sh backup` | Saves the database and uploaded files to `backups/` (keeps 14) |

**Updates:** Bigcapital's setup includes an auto-update helper that checks hourly for new versions
of its server and web app. Run `./bigcapital.sh upgrade` after big releases so database changes are
applied.

**Backups: set this up.** Run a nightly backup, and copy the `backups` folder off the server
(e.g. to your provider's backup storage or cloud drive):
```bash
(crontab -l 2>/dev/null; echo "15 2 * * * /opt/bigcapital/bigcapital.sh backup >> /opt/bigcapital/backups/backup.log 2>&1") | crontab -
```
Also turn on your VPS provider's automatic server snapshots if they offer them.

## Settings

All settings are in `/opt/bigcapital/.env` (only root can read it; it holds the passwords).
After changing it, run `./bigcapital.sh restart`. Useful ones:

- `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS`: outgoing email.
- `SIGNUP_ALLOWED_EMAILS`: who may sign up (set to your email). Set `SIGNUP_DISABLED=true` once
  everyone's account exists.
- `OPEN_EXCHANGE_RATE_APP_ID`: only if you use foreign currencies.

## Running the installer again

It's safe to re-run: it keeps the existing `.env` and its passwords, refreshes Bigcapital's official
files, and starts anything that isn't running.

## Connecting it to Crewdesk later

Bigcapital has an API, so Crewdesk can later post approved payroll as journal entries and work
order costs as expenses. That's a separate step; nothing here sets it up.
