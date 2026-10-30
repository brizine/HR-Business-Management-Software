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
| **Time clock** | Clock in/out from phone or web with GPS, live "who's on the clock", weekly timesheets with FLSA overtime, manager punch edits and approvals; optional **location rules and job-site geofencing**, set separately for clock-in and clock-out. See [Location rules](#location-rules--job-sites) |
| **Time off** | Multiple policies, accrual per hour worked with caps, grants/adjustments ledger, request → approve/deny, balance checks |
| **Hiring** | Job postings, public careers page (`/careers/<companyId>`), applicant pipeline board, one-click hire → employee |
| **Onboarding** | Hire form (start date, pay, manager, checklist) → invite email → new hire sets their password and works through a checklist of check-off, **upload** (phone camera works) and **sign** tasks; managers and admins see what's waiting on them; reminders and milestone notifications; the hire becomes active when everything is done. See [Onboarding](#onboarding) |
| **Payroll** | Optional provider: export each pay period as CSV (regular, overtime and approved time-off hours, estimated gross; approved-time-only option) and run payroll anywhere, **or** send hours to Check. See [Payroll](#payroll) |
| **Pay & tax forms** | Optional: employees fill out **W-4**, **I-9** Section 1 and **direct deposit** online (admins complete I-9 Section 2); encrypted, access-logged, PDF records; an "enter in payroll" queue for admins. See [Pay & tax forms](#pay--tax-forms) |
| **Fleet & equipment** | Asset registry (vehicles, trailers, heavy/small equipment, tools), odometer + engine-hour meters, registration/insurance expiry |
| **Preventive maintenance** | Schedules by miles, engine hours and/or days (whichever comes first), due-soon/overdue status, fleet-wide due list |
| **Work orders** | Numbered work orders with priority, assignment, parts/labor cost, vendor; completing one resets its maintenance schedule; critical issues take the asset out of service |
| **QR labels** | Printable QR label per asset; scanning with any phone camera opens a phone-friendly page to inspect, log a reading or report an issue, no app needed. The app has a built-in scanner. See [QR labels](#qr-labels) |
| **Spray Mix Calculator** | The Spray Tank Fill spreadsheet as a calculator: everyone enters tank gallons and taps **Update total**; admins choose which employees can edit products, rates and mixes; every change is logged. Web and app. See [Spray Mix Calculator](#spray-mix-calculator) |
| **Inspections** | Pre-trip/pre-use checklists (DVIR-style) on mobile; any defect automatically opens a work order |
| **Notifications** | Push to phones (Expo), in-app inbox, **email** and **text messages**, with per-person, per-category settings (mute anything, email/text only when someone doesn't have the app). See [Notifications](#notifications) |
| **Company wiki** | Pages and sub-pages with per-page "who can see" and "who can edit" levels (everyone / managers / admins), a company setting for who can create pages, search, pinning, version history with restore, and optional notifications. Read on the phone, edit on the web. See [Company wiki](#company-wiki) |
| **Dashboard** | Headcount, on-the-clock, pending PTO, overdue maintenance, open work orders, expiring registrations |

The mobile app covers what field staff need: clock in/out with GPS, weekly hours, time-off
requests (and approvals for managers), assigned assets, meter readings, inspections, issue
reports, assigned work orders, onboarding tasks and document signing.

## Try it

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/brizine/HR-Business-Management-Software)

Click the button to run Crewdesk with a demo company in your browser. Steps and demo logins are in
[docs/try-it.md](docs/try-it.md). To run it on your own computer instead, see **Running locally** below.

## Hosting

Production runs as a single Node.js process (website + API under `/api`) with PostgreSQL:

```bash
pnpm install
pnpm build      # builds the website and the API
pnpm start      # migrates the database, then serves everything on $PORT
```

**SiteGround:** step-by-step guide in [docs/deploy-siteground.md](docs/deploy-siteground.md).
The same two commands work on most Node.js hosts (Render, Railway, Fly.io).

### Upgrading an existing install to encrypted documents

Documents uploaded before encryption still open. To encrypt them in place, run once:
`pnpm --filter @crewdesk/api encrypt-uploads` (with the same environment as the server).

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

Demo logins (password `password123`; two-factor is optional in the demo company): `owner@demo.test`, `manager@demo.test`,
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

## Location rules & job sites

**Time clock → Job sites & location rules** (managers; rules are set by admins). Clocking in and
clocking out each get their own rule:

| Rule | What happens |
| --- | --- |
| **Optional** (default) | Location is recorded if the phone shares it. Nobody is blocked. |
| **Required** | Location must be on; anywhere is fine. |
| **Required; flag if away from a job site** | The punch goes through, but if it's outside every job site it's flagged ⚠ on the timesheet and the person's manager is notified. |
| **Required at a job site** | The punch is refused outside every job site, with how far away the nearest one is. |

A common setup is **clock-in: required at a job site**, **clock-out: flag if away**, so crews can't
start the clock from home but can still clock out on the drive back.

- **Job sites** have a name, a location and a radius (50 m–2 km, default 150 m). Add one by pasting a
  Google/Apple Maps link, typing `latitude, longitude`, or tapping "Use my current location" while
  standing there. Deactivate seasonal client sites instead of deleting them.
- **GPS accuracy:** a punch counts as on site within the radius plus the phone's reported accuracy,
  allowing up to 100 m, so a weak fix at the edge of a property isn't refused.
- **No sites yet?** Job-site rules act like "Required" until at least one active site exists, so
  nobody is locked out during setup.
- **Privacy:** location is captured once per punch, never tracked in between. The rules are checked
  on the server, so they can't be bypassed by changing the app. GPS can still be faked with special
  apps; the flags and map links help spot oddities.
- **Can't punch?** Managers can always add or fix time on the timesheet.
- **Legal:** some states require written notice (or consent) before recording employee location.
  Tell employees before turning on a required rule.

## Spray Mix Calculator

**Spray Mix Calculator** at the top of the sidebar on the web, and its own **Spray Mix** tab in the app. It's
the "Spray Tank Fill" spreadsheet as a shared calculator.

- **Everyone** picks a mix (*Truck 2gal/1000ft*, *Truck 1.5gal/1000ft*, *Backpack 1gal/1000ft*,
  *ZSpray(Green Tips)*), enters **Tank mix in desired
  gallons** and taps **Update total**. They see each product's amount, plus how many acres and
  square feet the tank covers. Each person's tank size is their own (remembered on their device),
  so one crew's fill doesn't change anyone else's screen.
- **Editing** products, rates, measurements, a mix's gallons per acre and default tank size, and
  adding or removing products and mixes, is limited to **admins plus the employees an admin
  checks** under **Who can edit**. Editors change things right in the calculator: click a product's
  name, rate or measurement (or the mix name, gallons per acre, default tank or notes), type, and press Enter or
  click away to save (Esc cancels). Add a product in the blank row at the bottom; × removes one. In
  the phone app, tap a product to change it, or tap the gallons-per-acre line for the mix settings
  and default tank. **More settings** has the rest: product order and deleting a mix.
- **Every change is logged** with who made it and the old and new values (e.g. "Aquacap: rate
  47.9 → 50 per acre"), shown under **Change history**.
- **Math:** rate per 1,000 ft² = rate per acre ÷ 43.56; product needed = rate per acre × tank
  gallons ÷ the mix's gallons per acre. It matches the original spreadsheet to six decimal places
  on every row but one: the spreadsheet's Z-spray **90/10 Surfactant** cell (F36) used the
  truck-mix formula and gave 3.86 oz for 12 gal; the consistent formula gives 30.27 oz. Check that
  rate against the product label.
- **Truck 1.5gal/1000ft** (65.34 gal/acre, 75-gal tank) and **Backpack 1gal/1000ft** (43.56 gal/acre,
  4-gal tank) use the Truck 2gal/1000ft products and per-acre rates; less water per acre means more
  product per gallon. Companies that already had mixes get both added after the 2 gal truck mix,
  copied from its current rates.
- **Starting point:** with no mixes yet, an editor can click **Start with the Truck, Backpack and
  ZSpray mixes** to load all four (the 2 gal truck and ZSpray sheets with the spreadsheet's rates).
- **Print** gives a clean copy for a clipboard in the truck.

## Company wiki

**Company wiki** (top of the sidebar; **Me → Company wiki** in the app) holds policies, how-tos,
the payroll calendar, safety rules and so on.

- **Per-page access:** each page has a **Who can see it** level and a **Who can edit it** level:
  *Everyone*, *Managers and admins*, or *Admins only*. Editors must be able to see the page, and only
  admins can change a page's levels, pin it or move it. People can't see, search or find out about
  pages above their level (they get "not found").
- **Who can create pages:** admins choose under **Wiki settings**: admins only (the default),
  managers and above, or everyone. Nobody can create a page they couldn't see themselves.
- **Writing:** simple formatting (headings, lists, **bold**, links, tables) with Write/Preview tabs.
  Raw HTML is shown as text and unsafe links are removed, so a page can't run scripts.
- **History:** every save is kept with who made it and an optional note; editors can view and
  restore old versions. If two people edit at once, the second save is stopped instead of
  overwriting the first.
- **Notify:** tick "Notify everyone who can see this page" for important updates (e.g. a new safety
  rule). People can mute these under notification settings.
- **Deleting** (admins) keeps the page so it can be restored from Wiki settings; its sub-pages move
  up a level.
- **Accessibility:** proper headings, labelled controls, keyboard-friendly navigation with visible
  focus, and screen-reader labels for pinned and restricted pages.

## Account security

- **Two-factor sign-in** with any authenticator app (Google Authenticator, Microsoft Authenticator,
  1Password…), plus 10 one-time backup codes. The owner chooses who must use it under **Settings →
  Security** (default: owners and admins); anyone can turn it on for themselves. People newly
  required are walked through setup at their next sign-in. Secrets are encrypted in the database
  (`ENCRYPTION_KEY`), and each code works only once.
- **Lockout:** 5 wrong passwords or codes in a row lock the account for 15 minutes (admins can
  unlock it). Sign-in endpoints are also rate-limited per IP address.
- **Forgot password:** emailed one-time link, valid for an hour. Two-factor is still required after a reset.
- **Sign out everywhere:** from **Settings → Security**, the phone app, or (for admins) an employee's
  profile. It also stops push notifications to that person's phones. Changing a password, email or
  role, or making someone inactive, signs them out everywhere automatically.
- **Immediate effect:** every request re-checks the account, so making someone inactive and role changes apply at once.
- **Encryption:** all traffic is HTTPS. Uploaded documents are encrypted with AES-256-GCM (a separate
  key per file, from `ENCRYPTION_KEY`) before they're written to disk or a bucket. Passwords are
  bcrypt-hashed and two-factor secrets are encrypted. Database backups are encrypted with a public key
  whose private half stays offline (`pnpm backup:keygen`, or `openssl` as in the deploy guide).
  Other database fields rely on the host's disk encryption.
- **Website sessions** live in an `HttpOnly`, `SameSite` (and in production `Secure`) cookie that page
  scripts can't read. Cookie-authenticated changes must carry the `X-Crewdesk-Client` header, which
  other sites can't send, so forged cross-site requests are rejected. The phone app keeps its token in
  the iOS Keychain / Android Keystore.
- **Admin limits:** admins can't change the owner's or another admin's account or create admins; only
  the owner can. If someone loses their phone *and* backup codes, an admin (or the owner, for admins)
  can reset their two-factor from their profile; verify it's really them first.

## Onboarding

1. **Hire** an applicant at the Offer stage (or **Team → Add employee**). The form sets their start
   date, pay, manager and role, picks a checklist, and by default **emails an invite**.
2. The invite link (valid 7 days) opens a **Welcome** page where they choose a password (and set up
   two-factor if their role requires it), then land on their checklist. If email isn't set up, the
   admin is shown the link to text them. Admins can resend it from the person's profile.
3. Checklist tasks are one of:
   - **Check off**: e.g. "Fill out your W-4 with payroll".
   - **Upload**: finishes when they upload a photo or PDF. On a phone they can use the camera.
   - **Sign**: they read and e-sign their own copy of a company document, such as the handbook. Upload
     it on the Documents page as a company-wide document, then choose it in the template.

   New hires can't check off upload/sign tasks without doing them. Managers and admins can mark any
   task done, e.g. after receiving a paper copy.
4. **Managers** see "Waiting on you" on the Onboarding page and in the app's Tasks tab. They're told
   about their tasks when someone's hired, when the new hire finishes their paperwork, and when the
   whole checklist is done (the employee then becomes **active**).
5. **Reminders**: from 7 AM local time, anyone with tasks due today or overdue gets one combined
   message (each task is announced once as due and once as overdue).

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

A payroll provider is **optional**. Under **Payroll → Payroll settings** the owner chooses:

- **No payroll provider** (default): pick the pay period and **Export CSV**. One row per employee with
  pay type and rate, regular hours, overtime hours (1.5× after the weekly threshold), approved
  **time-off hours** (split by day when a request crosses pay periods) and estimated gross. Key it
  into QuickBooks, ADP, Gusto or Paychex, or send it to your accountant. Unapproved time entries are
  flagged, and **Approved time only** leaves them out.
- **Check** (embedded payroll): **Send to Check** creates a draft payroll there for you to approve.
  Set `CHECK_API_KEY`, enter the Check company ID, and store each employee's Check ID. Verify the
  request format against Check's docs and test in their sandbox first.

Tax calculation, filings and paying employees stay with your payroll system or accountant.

## Pay & tax forms

With **Collect W-4, I-9 and direct deposit forms in Crewdesk** on (Payroll settings), employees fill
these out online under **Pay & tax forms**, or from onboarding tasks of the kind "Fill out a form":

| Form | Who | What happens |
| --- | --- | --- |
| **W-4** (federal withholding) | Employee | All W-4 steps, including a Step 3 calculator. Updating it supersedes the old one. |
| **I-9 Section 1** | Employee, by their first day | Citizenship/immigration status with the right follow-up fields. Locked once verified. |
| **I-9 Section 2** | Admin, within 3 business days | Record the List A, or List B + C, documents examined. Nobody can verify their own I-9. |
| **Direct deposit** | Employee | Routing-number checksum and a typed-twice account number. |

Each form is signed with the form's exact statement ("Under penalties of perjury…"), a typed name and
an "I agree" box, and Crewdesk records the time, IP address and browser. **Download PDF** produces a
record copy with every answer and the signature details. Enter your legal name, EIN and address in
Payroll settings so they print on the forms.

**Privacy.** Answers, including Social Security and bank numbers, are encrypted with their own key.
Lists only show the last 4 digits. Only the employee and admins can open a form (managers can't), and
every view or download is logged and shown to admins on the form.

**Manual payroll workflow.** When someone submits or updates a W-4 or direct deposit form, admins are
notified ("Payroll & tax forms") and it appears under **Waiting on you**. Enter it in your payroll
system, then click **Mark entered in payroll**.

**Things to know**
- These are electronic versions of the forms, not the official IRS/USCIS PDFs; the official ones
  couldn't be downloaded when this was built. The IRS allows electronic W-4 systems, and USCIS allows
  electronic I-9s, if they meet certain requirements (electronic signature with the attestation, an
  audit trail, and printable copies on request). Have your accountant or employment attorney confirm
  this setup works for you. `W4_AMOUNTS` (in `packages/shared/src/taxForms.ts`) holds the Step 3
  per-dependent amounts; check them against each January's W-4.
- **State withholding** forms vary by state. Add a state form as an "Upload a document" task, with a
  link to your state's form in the description.
- **I-9 Supplement A** (preparer/translator) and **Supplement B** (reverification) are done on paper.
  Crewdesk flags when a preparer was used.
- **E-Verify**, if you use it, is still done on the E-Verify site.
- **Keep records:** W-4s for at least 4 years. I-9s for 3 years after the hire date or 1 year after
  employment ends, whichever is later. Crewdesk keeps every version, including after someone is
  marked inactive (there's no way to delete employees).
- If you switch to a provider that collects these itself, turn the setting off; forms already on
  file stay available.

## Before production

This is a working foundation, not a finished product. Before real customers use it:

- **File storage**: set `UPLOAD_DIR` outside the deployed code, or use an S3/R2 bucket (`S3_*` settings).
- **Auth**: invite emails for new staff and optional single sign-on (Google Workspace / Microsoft 365).
- **Sensitive data**: SSNs/bank details should live only with the payroll provider. If you must store them, encrypt at the field level.
- **Notifications**: delivery history/audit log, email digests instead of one email per event, an inbound Twilio webhook for START/HELP, and Expo push receipt checking.
- **Compliance**: I-9/W-4 form generation, state-specific overtime (e.g. California daily OT), meal/break rules, record retention. Consider a signature provider (Dropbox Sign, DocuSign) for legally stronger audit trails.
- **Ops**: error monitoring, an audit log, uptime alerts on `/api/health`, and App Store / Play Store submission (see the deploy guide).
- **Billing**: Stripe subscriptions per company if you sell this as SaaS.

## Roadmap ideas

Shift swaps between employees, geofenced clock-in, performance reviews, benefits enrollment, parts
inventory, fuel logs and cost-per-mile, telematics/GPS integrations (Samsara, Geotab) to auto-update
odometers, NFC tags as an alternative to QR labels, and reports/exports.
