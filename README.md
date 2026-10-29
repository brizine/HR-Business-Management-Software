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
| **Time clock** | Clock in/out from phone or web with GPS, live "who's on the clock", weekly timesheets with FLSA overtime, manager punch edits and approvals |
| **Time off** | Multiple policies, accrual per hour worked with caps, grants/adjustments ledger, request → approve/deny, balance checks |
| **Hiring** | Job postings, public careers page (`/careers/<companyId>`), applicant pipeline board, one-click hire → employee |
| **Onboarding** | Checklist templates (employee / manager / admin tasks with due dates), progress tracking, employee auto-activates when done |
| **Payroll** | Hours + estimated gross preview, **CSV export** for any payroll system, **or** push to an embedded payroll provider (Check adapter included) |
| **Fleet & equipment** | Asset registry (vehicles, trailers, heavy/small equipment, tools), odometer + engine-hour meters, registration/insurance expiry |
| **Preventive maintenance** | Schedules by miles, engine hours and/or days (whichever comes first), due-soon/overdue status, fleet-wide due list |
| **Work orders** | Numbered work orders with priority, assignment, parts/labor cost, vendor; completing one resets its maintenance schedule; critical issues take the asset out of service |
| **Inspections** | Pre-trip/pre-use checklists (DVIR-style) on mobile; any defect automatically opens a work order |
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
- **Notifications**: push notifications (Expo) and email for PTO decisions, maintenance due, assignments, expiring registrations.
- **Compliance**: I-9/W-4 form generation, state-specific overtime (e.g. California daily OT), meal/break rules, record retention. Consider a signature provider (Dropbox Sign, DocuSign) for legally stronger audit trails.
- **Ops**: hosting (e.g. API on Fly/Render/AWS, web on Vercel, Postgres managed), backups, error monitoring, audit log, EAS builds and App Store / Play Store submission.
- **Billing**: Stripe subscriptions per company if you sell this as SaaS.

## Roadmap ideas

Scheduling/shift planning, geofenced clock-in, performance reviews, benefits enrollment, parts
inventory, fuel logs and cost-per-mile, telematics/GPS integrations (Samsara, Geotab) to auto-update
odometers, QR codes on equipment to open its page in the app, and reports/exports.
