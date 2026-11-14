# Crewdesk user guide

This guide is what the Help assistant answers from. Keep it in plain language and up to date when
features change. Menu names are written as they appear in the left sidebar.

## Roles and access

- **Roles:** Owner, Admin, Manager, Employee. Owners can do everything. Admins manage people, pay
  and settings. Managers run schedules, approve time and time off, and manage the fleet. Employees
  see their own information and do their own tasks.
- **Settings → Permissions** (owners, and anyone given "manages permissions") sets, area by area,
  what each person can do: no access, view, manage, or admin. **Settings → Layout Editor → Role
  access** sets the defaults for each role.
- Some sidebar items only appear for the roles that can use them (for example Payroll and
  Accounting for admins, Hiring and Dashboard for managers).

## Signing in and security

- Sign in with your email and password. **Forgot your password?** on the sign-in page emails a
  reset link that works for an hour.
- **Two-factor sign-in:** people the company requires it for (default: owners and admins) get a
  6-digit code by email each time they sign in. It works for 10 minutes and only the newest code
  counts; **Send a new code** sends another. Anyone can use an authenticator app instead
  (**Settings → Security → Use an authenticator app**): scan the QR code once, save the 10 backup
  codes, then enter the app's code at each sign-in. App users can still click **Email me a code
  instead**. The QR code is only shown once, at setup, for security.
- Lost phone and backup codes: an admin can reset someone's two-factor from their profile.
- The owner chooses who must use two-factor under **Settings → Security → Company: who must use
  two-factor**.
- **Settings → Security** also has password change and **Sign out everywhere**.

## Settings

- **My Info:** your contact details, address, emergency contact and photo.
- **Security:** two-factor, password, signed-in devices.
- **Notifications:** what alerts you get and how. For each kind (time off, time clock &
  attendance, schedule, fleet, documents, onboarding, hiring, payroll, wiki, reviews, training):
  **App & inbox** (the Notifications list in Crewdesk plus phone pop-ups if you have the app),
  **Email** (always, only if you don't have the app, or off) and **Text**. Owners and admins can
  pick any employee from the **Change notification settings for** drop-down at the top, or open
  someone's profile and click **Notifications**.
- **Company Info:** company name, logo, address (separate boxes), phone, email, website, time zone.
- **Layout Editor** (owner): drag boxes and fields to rearrange pages, hide items, edit drop-down
  menus (job titles, departments and so on), and set **Role access**.
- **Permissions:** per-person access by area, with search and filters.

## Notifications

The **Notifications** link at the top of the sidebar is your inbox; the red number is unread
alerts. Phone pop-ups need the Crewdesk app installed and signed in.

## Dashboard

Headcount, who's on the clock, pending time off, overdue maintenance, open work orders and expiring
registrations at a glance (managers and up).

## Company Wiki

Pages and sub-pages for policies and how-tos. Each page has who can see it and who can edit it
(everyone, managers, admins). Search, pin important pages, view history and restore an older
version. Read on the phone, edit on the website.

## Spray Mix Calculator

Enter the tank size in gallons and tap **Update total** to see how much of each product to add.
Admins choose which employees can edit products, rates and mixes; every change is logged under
**Change history**.

## Team

- The employee directory, with search and filters. Click a person to open their profile.
- **Add employee** (or **New hire** from Onboarding) creates someone; you can give them a password
  or send an invite email so they set their own. Resending an invite cancels the old link.
- A profile shows contact details, pay (managers and up), documents, time off, attendance,
  reviews, training, tasks and a **Clock in** box. Buttons at the top include Notifications and
  resetting two-factor.
- Phone numbers are formatted as (555) 555-5555 automatically.
- Marking someone inactive or terminated (with a reason, visible to managers) signs them out.

## Schedule

- The week grid: one row per person plus **Open shifts** (anyone can claim them). Change the week
  with the calendar drop-down at the top.
- **+ Add shift** (top) or the faint **+** in any day opens **New shift**. Pick **Days** (tick any
  days of the week, or **Mon–Fri** / **Every day**), who, start and end time, position, job site,
  vehicle and notes. **Repeat** puts the same shifts on the following weeks too (days someone is
  already booked are skipped). An end time earlier than the start means the shift runs past
  midnight.
- Click a shift to edit or delete it. **Copy this shift to the same day for the next N weeks**
  copies it forward.
- **Change or delete shifts** changes or deletes every shift in a date range at once (this week,
  next week, this month, any dates; everyone's, one person's or open shifts; drafts and/or
  published): new start or end times, a different person, position, job site, vehicle or notes, or
  delete them all. It's all or nothing if someone would be double-booked.
- New shifts are **drafts** (dashed) that only managers see until you click **Publish**, which
  notifies everyone with shifts that week. **Copy last week** brings last week's shifts forward as
  drafts. **Templates** save shifts you use often.
- Double-booking is blocked. Approved time off, "can't work" availability and vehicles in the shop
  give warnings. Over 40 hours a week is flagged.
- Employees can claim open shifts and ask to drop a published shift (a manager approves).
  Part-time staff set **My availability** (times they can't work).
- The **Filters** box searches by name, job title, department, position, job site, vehicle and
  status.

## Time Clock

- Clock in and out on the website, the employee page's Clock in box, or the phone app (with GPS).
- Managers see who's on the clock now and weekly timesheets with overtime, can fix or add punches,
  and approve time.
- **Job sites & location rules:** set separately for clocking in and clocking out: Optional,
  Required, Required and flag if away from a job site, or Required at a job site. To add a job
  site, type the address and click **Find on map** (or paste a Google/Apple Maps link, type
  latitude, longitude, or use your current location), check it on the map, then **Add site**.

## Attendance

- **Calendar** (opens first): each day coloured: green worked as scheduled, yellow late or left
  early, red no-show, blue called in sick, grey excused/time off; ⏰ means clocked in earlier than
  allowed; ✎ means changed by an owner/admin. Pick the person in the Filters box.
- **Click a day** to see its punches. Managers can **Fix times**, **Remove** a punch, or
  **+ Add a missed punch**; the day's colour and points update and the timesheet changes too.
  Owners and admins can **Change status or points** (for example mark called in sick) with a note.
- **Report:** everyone's totals for a date range (on time, late, left early, no-shows, sick,
  excused, early clock-ins, on-time rate, points), with filters.
- **Rules & settings** (owners/admins change them): late buffer, leaving-early buffer, no-show
  time and alerts; clock-in early buffer (just note it, add points, or don't allow clocking in that
  early); attendance points for late, left early, no-show and sick; bigger points for very late or
  leaving very early; whether late and left early on the same day both count; how long points last;
  and point levels (for example 3 = verbal warning) that alert managers.

## Time Off

- **Request time off** (here or on the employee page): start, end, type and hours; it shows hours
  available. Managers approve or deny.
- Policies: hours earned per hour worked and/or awarded by date, rates that grow with years of
  service, caps and carryover limits.
- **Paid holidays** with rules (for example must work the scheduled day before and after; approved
  time off counts).

## Reviews & Discipline

Performance reviews and disciplinary actions. Drafts are visible to managers only until shared;
employees acknowledge each one. Filters and search at the top.

## Training

Courses with lessons and quizzes, assigned to people with due dates; progress tracking and
reminders. Managers create and assign courses.

## Documents

Company-wide, per-employee and per-asset documents, with e-signatures. Filters by category, who it
belongs to, signature status and date.

## Pay & Tax Forms

Employees fill out W-4, I-9 Section 1 and direct deposit online; admins complete I-9 Section 2 and
see what needs entering in payroll.

## Onboarding

New-hire checklists (check off, upload and sign tasks), invite emails, and a list of what's waiting
on managers.

## Hiring

Job postings, a public careers page, an applicant board, and one-click hire.

## Payroll

- **Pay schedule:** how often you pay, when periods start, payday, and who approves (owners and
  admins). Pay periods show on a calendar.
- **Export hours** for a pay period (CSV) and **Timesheets to approve**.

## Accounting

Connects to Bigcapital (the company's accounting system). Approved pay periods can post as journal
entries and completed work orders as expenses, automatically or by hand. Set up the connection and
accounts on this page (admins).

## Assets (Vehicles & Equipment)

- The fleet list with maintenance status; click an asset for details: meters (odometer, engine
  hours), documents, QR label, work orders, inspections and **Preventive Maintenance Schedules**.
- **Add schedule:** service name, every X miles / engine hours / days (whichever comes first), last
  service, **Assign to** (they get its reminders and work orders made from it), and optional
  **Remind … before** timing. **Create work order** turns a due service into a work order.
- **Reminder settings** (top of the Assets page): company default for how far ahead "due soon"
  reminders go out (miles, engine hours, days; blank = 10% of the interval) and an optional repeat
  every N days while overdue. Each schedule can override this with **Change** in its Reminder
  column.
- **Print QR labels:** scanning a label with any phone camera opens a page to inspect, log a
  reading or report an issue.

## Work Orders

- **New work order** (managers) or **Report an issue** (everyone): asset, title, priority,
  description, assign to, and when it's due: a **date**, **mileage** and/or **engine hours**
  (whichever comes first).
- The **Due** column shows Upcoming / Coming due / Due now with how far off it is. The assignee and
  fleet managers are reminded as it comes due and when it's due.
- Click a work order to update status, assignee, due point, labor, parts cost, vendor and notes.
  Completing one linked to a schedule resets that schedule. Critical issues take the asset out of
  service until completed.

## Inspections

Pre-trip / pre-use checklists, mostly done in the phone app. Any failed item opens a work order
automatically.

## Phone app

Clock in and out, schedule and open shifts, time off, assigned vehicles, meter readings,
inspections, issue reports, work orders, training, onboarding tasks and signing documents.
