# Crewdesk

HR and fleet/equipment maintenance for small and local businesses: hiring, onboarding,
time tracking, PTO, documents and payroll export, plus vehicle and equipment
maintenance tracking. One TypeScript codebase with a web app, an iOS/Android app and an API.

```
apps/
  api/      Fastify + PostgreSQL (Drizzle ORM) REST API
  web/      Next.js web app for owners, managers and employees
  mobile/   Expo (React Native) app for iOS and Android
packages/
  shared/   Validation schemas, roles, maintenance-due and overtime logic used by all three
```

## Features

| Area | What's included |
| --- | --- |
| **People** | Employee directory and profiles, roles (owner / admin / manager / employee), pay info hidden from non-managers |
| **Documents** | Upload per employee, per asset or company-wide; typed-name e-signature with timestamp + IP |
| **Scheduling** | Weekly schedule grid, draft → publish, copy last week, saved shift templates, employee availability ("can't work Tuesdays"), open shifts employees can pick up, drop requests with manager approval, vehicle/equipment assigned per shift, double-booking prevention, time-off and overtime warnings, reminders an hour before each shift, scheduled vs. worked hours on timesheets. See [Scheduling](#scheduling) |
| **Time clock** | Clock in/out from phone or web with GPS, live "who's on the clock", weekly timesheets with FLSA overtime, manager punch edits and approvals |
| **Time off** | Multiple policies, accrual per hour worked with caps, grants/adjustments ledger, request → approve/deny, balance checks |
| **Hiring** | Job postings, public careers page (`/careers/<companyId>`), applicant pipeline board, one-click hire → employee |
| **Onboarding** | Checklist templates (employee / manager / admin tasks with due dates), progress tracking, employee auto-activates when done |
| **Payroll** | Hours + estimated gross preview, **CSV export** for any payroll system, **or** push to an embedded payroll provider (Check adapter included) |
| **Fleet & equipment** | Asset registry (vehicles, trailers, heavy/small equipment, tools), odometer + engine-hour meters, registration/insurance expiry |
| **Preventive maintenance** | Schedules by miles, engine hours and/or days (whichever comes first), due-soon/overdue status, fleet-wide due list |
| **Work orders** | Numbered work orders with priority, assignment, parts/labor cost, vendor; completing one resets its maintenance schedule; critical issues take the asset out of service |
| **QR labels** | Printable QR label per asset; scanning with any phone camera opens a phone-friendly page to inspect, log a reading or report an issue, no app needed. The app has a built-in scanner. See [QR labels](#qr-labels) |
| **Inspections** | Pre-trip/pre-use checklists (DVIR-style) on mobile; any defect automatically opens a work order |
| **Notifications** | Push to phones (Expo), in-app inbox, **email** and **text messages**, with per-person, per-category settings (mute anything, email/text only when someone doesn't have the app). See [Notifications](#notifications) |
| **Dashboard** | Headcount, on-the-clock, pending PTO, overdue maintenance, open work orders, expiring registrations |

The mobile app covers what field staff need: clock in/out with GPS, weekly hours, time-off
requests (and approvals for managers), assigned assets, meter readings, inspections, issue
reports, assigned work orders, onboarding tasks and document signing.

## Running locally

Requires Node 22+, pnpm 10+, and PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose up -d                       # or use an existing Postgres
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/mobile/.env.example apps/mobile/.env
pnpm db:migrate
pnpm db:seed                               # demo company + data
pnpm dev:api                               # http://localhost:4000
pnpm dev:web                               # http://localhost:3000
pnpm dev:mobile                            # scan the QR code with Expo Go
```

Demo logins (password `password123`): `owner@demo.test`, `manager@demo.test`,
`tech@demo.test`, `crew@demo.test`.

On a physical phone, set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your computer's LAN IP
(e.g. `http://192.168.1.20:4000`).

### Tests

```bash
pnpm test        # shared logic unit tests + API integration tests (needs DATABASE_URL)
pnpm typecheck
```

### Changing the database

Edit `apps/api/src/db/schema.ts`, then `pnpm --filter @crewdesk/api db:generate` and `pnpm db:migrate`.

## QR labels

Every vehicle and piece of equipment gets a short code (e.g. `ET2W42AUDZ`) and a QR label that
links to `https://<your site>/q/<code>`.

- **Printing:** **Assets → Print QR labels** prints a sheet for the whole fleet (large 4″×2″ or small
  2.6″×1″), or use **Print label** / **Download SVG** on a single asset. Use weatherproof vinyl
  labels outdoors.
- **Scanning:** any phone camera opens the scan page: big buttons for a pre-trip inspection,
  logging the odometer/hours, and reporting an issue, plus open work orders and maintenance due.
  People who aren't signed in log in and land right back on it. In the Crewdesk app, the Fleet tab
  has a **Scan equipment QR** button.
- **Damaged label:** the code is printed under the QR and can be typed into the app's scanner screen.
- **Lost or stolen label:** a manager clicks **New code** on the asset; the old label stops working.
- Labels only work for signed-in members of the same company, so a label seen by the public
  reveals nothing.

If staff reach the site at a different address than the one you print from, set
`NEXT_PUBLIC_WEB_URL` in `apps/web/.env.local` so labels point to the right place. To have labels
open the app instead of the browser on phones that have it installed, set up iOS Universal Links /
Android App Links for your domain (the app already handles `/q/<code>` links).

## Scheduling

Managers build the week on the **Schedule** page: click **+** in any cell to add a shift (an end
time earlier than the start means it runs past midnight), or **Copy last week** to start from the
previous schedule. New shifts are **drafts** that only managers can see (dashed outline) until
**Publish**, which notifies everyone with shifts that week.

- **Templates:** open any shift and click **Save as template** (e.g. "Morning crew 7:00–15:30,
  Driver, Truck 12"). New shifts can start from a template; manage them under **Templates**.
- **Availability:** employees set recurring times they can't work, either a whole day or part of
  one ("Tuesdays", "Fridays before 2pm"), under **My availability** on web or in the app's Schedule
  tab. Managers can edit it from an employee's profile. Their manager is notified of changes, those
  cells are striped on the grid, and scheduling into them shows a warning (not a block, since you may
  have agreed to it). One-off days off still go through time-off requests.
- **Conflicts:** double-booking someone is blocked. Scheduling over approved time off or availability,
  or assigning a vehicle that's in the shop, saves but shows a warning. Weekly totals over 40 hours are flagged.
- **Open shifts:** leave "Who" empty and anyone can pick it up from the web or the app's Schedule
  tab. The first person to claim it gets it.
- **Dropping a shift:** employees ask to drop a published shift; if a manager approves, it becomes
  an open shift and the team is notified.
- **Time clock:** the app shows your next shift on the Clock tab, and timesheets show scheduled
  next to worked hours.

Shift times are stored as exact instants and shown in each viewer's local time. Copying a week
moves shifts by exactly 7 days, so a copy across a daylight-saving change shifts by an hour.

## Notifications

Alerts reach people through up to four channels: the in-app inbox (bell icon on web and mobile),
push to any phone signed in to the app, email, and text message. Nobody is notified about their own
actions.

### Who gets what, and how

Each person chooses per category (time off, time clock, schedule, fleet, documents, onboarding,
hiring) in **Settings → Notification settings** on web or **Me → Notification settings** in the app:

| Channel | Options | Default |
| --- | --- | --- |
| App & inbox | On / muted | On |
| Email | Off · Only if no app · Always | Only if no app |
| Text | Off · Only if no app · Always | Off |

"Only if no app" means the person isn't signed in to the Crewdesk app on any phone, so employees who
never install the app still hear about their schedule, time off and so on by email (or text).
Admins can open the same settings for any employee from their profile, which helps for staff who
never log in.

**Texts** need three things: the owner turns on "Allow text messages" for the company (texts cost
money), the employee has a valid mobile number, and the employee opts in. Opt-in is recorded with a
timestamp; an admin may record it on someone's behalf only with their consent. If someone replies
STOP, Twilio blocks further texts and Crewdesk turns their opt-in off automatically.

**Emails** include a one-click unsubscribe link for that category (and the `List-Unsubscribe`
headers Gmail and Yahoo look for), plus a link to the full settings page.

### Setting up email and text

Add to `apps/api/.env`:

- `SMTP_URL` and `EMAIL_FROM`: any SMTP email service (Postmark, SendGrid, Amazon SES, Mailgun,
  Google Workspace…). Use a sending domain with SPF/DKIM set up so mail doesn't land in spam.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`).
  Texting US numbers from an app requires **A2P 10DLC registration** in Twilio (brand + campaign),
  which takes a few days to approve.
- `WEB_URL` and `PUBLIC_API_URL`: public addresses used for links in emails and texts.

If these aren't set, the channel is simply skipped and the settings pages say so.

### Events

| Event | Who gets it |
| --- | --- |
| Time-off request submitted | The employee's manager (or admins if no manager is set) |
| Time-off approved / denied | The employee |
| Work order assigned | The assigned technician |
| Issue reported from the field, or any high/critical work order | Managers and above |
| Inspection failed | Managers and above |
| Work order completed | Whoever reported it |
| Document needs signature | The employee |
| Onboarding checklist assigned | The new hire |
| New applicant on the careers page | Managers and above |
| Maintenance due soon / overdue *(scheduled)* | Managers and the asset's assigned driver; once per service interval |
| Registration / insurance expiring within 30 days *(scheduled)* | Managers and above |
| Clocked in over 12 hours *(scheduled)* | The employee and their manager |
| Schedule published | Each person with shifts that week (one alert each) |
| Published shift changed, reassigned or removed | The people affected |
| Open shifts posted, or a dropped shift reopened | All employees |
| Open shift picked up / drop requested | The employee's manager |
| Drop request approved / denied | The employee |
| Shift starting within the hour *(scheduled)* | The employee |
| Availability changed | The employee's manager |

Scheduled checks run every 15 minutes inside the API process and are deduplicated in the
database, so running several API instances is safe. To use an external cron instead, set
`DISABLE_SCHEDULER=true` and run `pnpm --filter @crewdesk/api jobs:run`.

### Enabling push on phones

Push goes through Expo's push service, which relays to Apple (APNs) and Google (FCM). One-time setup:

1. `npm i -g eas-cli && cd apps/mobile && eas init`. This creates an Expo project and fills in
   `extra.eas.projectId` in `app.json`.
2. Build a development or production build with `eas build`. **Expo Go cannot receive push on
   Android** (SDK 53+), so use a development build for testing. EAS creates the iOS push key for you;
   for Android, add an FCM V1 service-account key with `eas credentials`.
3. Push only works on physical devices, not simulators. Without a project ID the app still works and
   the in-app inbox still fills; it just skips push registration.

If you turn on "enhanced push security" for the Expo project, set `EXPO_ACCESS_TOKEN` in the API's `.env`.

## Payroll

Admins pick a pay period on the Payroll page and either:

1. **Export CSV**: regular/overtime hours, rate and estimated gross per employee, ready to import into
   any payroll service (QuickBooks, ADP, Gusto, a bookkeeper).
2. **Send to payroll provider**: creates a draft payroll with the provider for review and approval.
   The `PayrollProvider` interface in `apps/api/src/lib/payroll` has a Check
   (checkhq.com) implementation; Gusto Embedded or others can be added the same way. To enable:
   set `CHECK_API_KEY`, choose "Check" in payroll settings, enter the Check company ID, and store each
   employee's Check ID in `payroll_provider_employee_id`. Verify the request format against the
   provider's current API docs and test in their sandbox before going live.

Both options are always available. Tax calculation, filings and money movement stay with the
provider, which avoids building payroll tax compliance in-house.

## Before production

This is a working foundation, not a finished product. Before real customers use it:

- **File storage**: swap `LocalStorage` (`apps/api/src/lib/storage.ts`) for S3/R2/GCS.
- **Auth hardening**: password reset and invite emails, refresh tokens, rate limiting on login, optional SSO/2FA.
- **Sensitive data**: SSNs/bank details should live only with the payroll provider. If you must store them, encrypt at the field level.
- **Notifications**: delivery history/audit log, email digests instead of one email per event, an inbound Twilio webhook for START/HELP, and Expo push receipt checking.
- **Compliance**: I-9/W-4 form generation, state-specific overtime (e.g. California daily OT), meal/break rules, record retention. Consider a signature provider (Dropbox Sign, DocuSign) for legally stronger audit trails.
- **Ops**: hosting (e.g. API on Fly/Render/AWS, web on Vercel, Postgres managed), backups, error monitoring, audit log, EAS builds and App Store / Play Store submission.
- **Billing**: Stripe subscriptions per company if you sell this as SaaS.

## Roadmap ideas

Shift swaps between employees, geofenced clock-in, performance reviews, benefits enrollment, parts
inventory, fuel logs and cost-per-mile, telematics/GPS integrations (Samsara, Geotab) to auto-update
odometers, NFC tags as an alternative to QR labels, and reports/exports.
