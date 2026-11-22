# Crewdesk user guide

This guide is what the Help assistant answers from. Keep it in plain language and up to date when
features change. Menu names are written as they appear in the left sidebar.

## Getting help

The blue **? Help** button near the bottom of the left menu, above **Settings**, opens Help: **Ask the Assistant** (type a
question, get step-by-step answers) and **User Manual** (this guide, with contents and search).

## Finding your way: Operations and Team

The left menu has two sides. The **Operations | Team** switch near the top flips between them:

- **Operations:** **Reports** (managers), **Customers** (**Customers**, **Properties**), **Tools**
  (**Property Measure**, **Spray Mix Calculator**) and **Fleet & Equipment** (**Assets**, **Repair Orders**,
  **Inspections**). Scheduling and billing will be added here.
- **Team:** **Dashboard** and **Reports** (managers), **People** (**Team**, **Shifts**, **Time Clock**,
  **Attendance**, **Time Off**, **Reviews & Discipline**, **Training**, **Documents**, **Onboarding**,
  **Hiring**) and **Pay** (**Payroll**, **Pay & Tax Forms**).
- **Always shown:** **Notifications**, **Company Wiki**, **Help** and **Settings**.
- Opening a page (or a link someone sent) switches the menu to that page's side by itself, and the
  menu remembers the side you used last on that computer.
- **Reports** on each side lists the reports you can see there, such as Fuel & Costs, Repair Orders and
  Inspections (Operations), or Attendance, Timesheets, Time Off, Training Progress and Payroll (Team).

## Roles and access

- **Roles:** Owner, Admin, Manager, Employee. Owners can do everything. Admins manage people, pay
  and settings. Managers run schedules, approve time and time off, and manage the fleet. Employees
  see their own information and do their own tasks.
- **Settings → Permissions** (owners, and anyone given "manages permissions") sets, area by area,
  what each person can do: no access, view, manage, or admin. **Settings → Layout Editor → Role
  access** sets the defaults for each role.
- Some sidebar items only appear for the roles that can use them (for example Payroll for
  admins, Hiring, Dashboard and Reports for managers).

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
  someone's profile and click **Notifications**. These settings are changed on the website; the phone app
  doesn't have them.
- **Company Info:** company name, logo, address (separate boxes), phone, email, website, time zone.
- **Layout Editor** (owner): drag boxes and fields to rearrange pages, hide items, edit drop-down
  menus (job titles, departments and so on), set **Role access**, and edit the **User Manual**
  (**Edit the user manual**: change anything or add company procedures, check it on **Preview**,
  then **Save the manual**; **Reset to the standard manual** undoes all edits). Help and the
  assistant use the edited copy. When Crewdesk's standard manual is updated, a notice offers the
  **Standard manual** tab so you can copy in what's new.
- **Permissions:** per-person access by area, with search and filters.
- **Customers** (admins in Customers & billing): the tag list and the cancellation reasons (see Customers & Properties).
- **Integrations** (payroll admins): connections to other systems; today, **Accounting (Bigcapital)**.

## Notifications

The **Notifications** link at the top of the sidebar is your inbox; the red number is unread
alerts. Phone pop-ups need the Crewdesk app installed and signed in.

## Dashboard

Headcount, who's on the clock, pending time off, overdue maintenance, open repair orders and expiring
registrations at a glance (managers and up). It's on the **Team** side of the menu.

## Company Wiki

Pages and sub-pages for policies and how-tos. Each page has who can see it and who can edit it
(everyone, managers, admins). Search, pin important pages, view history and restore an older
version. Read on the phone, edit on the website.

## Customers & Properties

Customers are the people and companies you bill; properties are the service addresses. They're separate
records: a property is assigned to one **bill-to** customer (who gets the invoices and pays) and any number
of **residents** (tenants, who get reminders). One customer can have many properties. Seeing and editing
customers takes manager access in **Customers & billing** (Settings → Permissions).

- **Customers** (Operations → Customers): search by name, phone, email, service address or customer number,
  filter by status (Current = active and leads; Active; Leads; Cancelled; All) and by tags. Click a tag once to
  show only customers with it, again to show only those without it, and again to clear it.
- **Add customer:** Residential, Commercial or HOA (commercial and HOA accounts are listed by company name),
  contact details, billing address, how invoices are sent (email, paper, text; any of them), how they heard
  about you, tags, notes and **Other contacts** (a spouse, property manager or accounts payable; tick **Copy on
  invoices** for anyone who should get a copy). Commercial accounts can be marked **Needs a PO number**. Tick
  **Add their service address now** to create their first property with them as bill-to (or untick **Service
  address is the billing address** to type a different one). Choose **Lead** for someone who hasn't bought yet.
- **Customer page:** contact and billing details, other contacts, their properties (current, and past ones
  under **Show past properties**) and any cancellations. **Add a property** creates a new service address for
  them as bill-to or resident.
- **Properties** (Operations → Properties): search by address, ZIP, label or customer; filter by **Map Code
  starts with** (e.g. 80 for 800–809; type **none** for properties without one), status, property tags, and the
  bill-to customer's tags (e.g. properties whose customer is tagged Commercial).
- **Property page:** Map Code, lawn size (front, back and total), gate code, pets, access notes, tags and the
  **People** on it. **Add a person** puts an existing customer on the property as a resident, or as the new
  bill-to: the old bill-to's time ends the day before, their past invoices stay with them, and the property's
  history stays with the property (**Show history**). **Moved out** ends a resident's time. **Map** opens the
  address in Google Maps.
- **Lawn size:** type front and back (the total is worked out) or just a total, or click **Use a saved
  Property Measure** to take the sizes from a measurement saved on the Property Measure page.
- **Cancelling:** **Cancel customer** or **Cancel property** asks for a reason from the list, an effective date
  and a comment (required for some reasons, such as Other). Cancelling a customer also cancels the properties
  they're the bill-to for; properties where they're only a resident are left alone. Cancelled records are
  hidden from everyday lists but kept with their history; **Reactivate** brings them back (reactivate each
  property from its own page).
- **Tags** (Settings → Customers, admins): add tags with a name, color and description, **Archive** ones no
  longer used (they stay where they are but can't be added), or **Merge** one tag into another. Every tag added
  or removed is recorded with who did it and when.
- **Cancellation reasons** (Settings → Customers, admins): add, rename, reorder (↑ ↓), mark as the customer's or
  your decision, require a comment, or retire reasons.
- **Sample customers** (admins, top of the Customers page): **Load sample customers** adds 10 made-up accounts
  plus 2 tenants, tagged Sample, covering the tricky cases (paper invoices, a landlord with tenants, a property
  manager, a PO-number account, an HOA, two properties, a prepay customer and a lead outside the service area).
  Their emails use example.com, so nothing reaches a real person. **Remove sample customers** deletes them all.
- **Deleting:** admins can delete leads, sample customers and customers or properties with no history; anyone
  else is cancelled instead, so the history is kept.

## Spray Mix Calculator

Enter the tank size in gallons and tap **Update total** to see how much of each product to add.
Admins choose which employees can edit products, rates and mixes; every change is logged under
**Change history**.
Editors can change the order of the products: drag a row up or down by its handle (⠿) at the left, on a
computer or a phone, or focus the handle and use the up and down arrow keys. The new order is saved for everyone.

## Property Measure

Measure turf square footage from aerial photos, choosing photos taken in winter when the leaves are off.

1. Start typing the property's address under **Find a property**: after a few letters, matching addresses
   drop down, nearest your shop first (type a house number, or just a street name to see matching streets and
   how many addresses each has); pick one with the mouse, or the arrow keys and Enter. You can also type the full
   address (or paste a Google Maps link, or latitude, longitude) and click **Find**. Addresses come first
   from the State of Oklahoma's 911 address list (the most complete, including new streets), then from
   OpenStreetMap. The 911 list for your counties (Cleveland, Oklahoma and McClain to start) is kept in
   Crewdesk and refreshed every 30 days; admins can add or remove counties, and set the **Shop location**
   suggestions are measured from (it starts as the business address in Company settings), under **Photo and address
   sources (admins)**. Addresses in other Oklahoma counties are still found with **Find**, just more slowly.
   A red pin marks the house. If it's not quite on the house, drag it there; it's saved with the measurement
   and shows when you print or export.
2. Pick a photo under **Aerial Photo**. **Oklahoma 2025 leaf-off** (February–March 2025, 6-inch detail)
   is the default. **Find more photo dates here** lists older Esri photos of that spot with the date each
   was taken; the ones marked **Leaf-off** were taken December to March.
   **Look at this spot in** opens the same place in Google Maps, Google Earth (which has past photos
   under its clock button) or Apple Maps in a new tab, to compare. Their photos can't be traced here.
3. Click **Add Area** (or Add Front Area, Add Back Area, Measure Line). The button stays selected, so you can trace
   one outline after another; choose another button to switch, or click the selected one again (or press Esc) to
   stop. Stop drawing before dragging corners to adjust them. Click each corner of the turf. While drawing, a crosshair shows where the next
   point will go, with the line's compass bearing and length. With **Snap** on (next to Show points), the next
   point locks to square corners (90°), straight runs, 45° and, for the first edge, north–south or east–west;
   it snaps onto existing corners, finds the fourth corner of a rectangle, and closes the shape on the first
   point. A green tag says what it snapped to and the line turns solid. Turn **Snap** off for curved beds or
   odd shapes. On a phone or tablet, the crosshair starts in the middle of the map: move the map under it,
   drag the crosshair by its box, or tap a spot to move it there, then press **Drop Point** to place each
   point (tapping never places one by itself). Press **Finish** when done. While drawing, **Undo Point** takes off the last point (Ctrl+Z) and
   **Redo Point** puts it back (Ctrl+Y). Double-click, press Enter, or click the first
   point to finish. **Add Front Area** (blue) and **Add Back Area** (purple) work the same way and count
   toward the front or back yard. For beds, driveways, patios and the house, trace them as an area on top of
   the lawn you already traced: when you finish, you're asked whether it's a hole. Answer **OK** and it
   becomes a cut-out (red dashed): the part inside the lawn is cut out of it, and that area's size goes down;
   a hole that hangs past the edge only removes the overlapping part. In the **Measurements** list you can
   switch any outline between Area, Front, Back and Hole. **Measure Line** measures lengths
   such as a perimeter barrier.
4. To add to a finished measurement, click its **lock** button in the Measurements list: it reopens (an orange
   unlocked padlock) and you keep tracing from its last point, then close it again (right-click, Finish, Enter, or the
   unlocked padlock). It keeps its name, type and place in the list; **Cancel** puts it back as it was.
   Click a measurement on the map to adjust it: drag a corner to move it, drag a small dot between corners to
   add one, double-click a corner to remove it. **Right-click and drag** a corner of any measurement to move it, even
   while a drawing button is selected; a plain **right-click** while drawing closes the outline (like Finish). Turn **Show points** off (next to the drawing buttons, and while
   drawing next to Finish) to hide the points, both the dots you place while drawing and the corner squares and
   circles, so you can see the outline clearly; while they're hidden, finish a shape with Finish, Enter or a
   double-click. Your measurements stay in place when you switch photos, so you can trace
   on one photo and check on another.
5. **Total Area** is everything (plain, front and back areas, minus cut-outs) in square feet and acres, with
   **Total Front Area** and **Total Back Area** below it, and the gallons of mix needed at any Spray Mix
   sheet's rate.
6. **Print** (top of the page) prints a one-page report: the photo with your outlines and sizes, the
   totals, the list of measurements, notes and the photo's source. **Export** saves the same thing as a
   **PDF report**, or the photo with outlines and totals as a **PNG** (best quality) or **JPEG** (smaller,
   for email and texts), or just the outlines as **KML** (opens in Google Earth) or **GeoJSON** (for GIS
   software). After you pick the type, a **Save As** box asks where to save it and what to call it (Chrome and
   Edge; Safari and Firefox save it like any download, wherever the browser is set to put downloads). The photo is
   saved as it's shown on the map, so zoom and pan to frame the property first.
7. Give it a name and **Save**. Everyone can open saved measurements under **Saved Measurements**; the
   person who saved one, or a Spray Mix manager, can change or delete it.

**New photos:** Oklahoma's statewide photos are found automatically. When the page is opened (at most twice a
day), Crewdesk checks OKMaps for newly released years; a new leaf-off year joins the list, is marked **New** for
60 days, and becomes the default. Esri's newest photos appear under **Find more photo dates here** as soon as Esri
publishes them. Admins can open **Photo and address sources (admins)** at the bottom of the Aerial Photo box to check now, or
to add other photos (a county's aerials, a paid service, or an Oklahoma release the automatic check doesn't
recognize) by WMS address and layer name, or a tile address with {z}/{x}/{y}.

Photos are from OKMaps (Oklahoma Office of Geographic Information), Esri World Imagery Wayback, and USDA
NAIP (summer photos, for comparison). Measurements are typically within a few percent, depending on the
photo and how carefully the edges are traced.

## Team

- The employee directory, with search and filters. Click a person to open their profile.
- **Add employee** (or **New hire** from Onboarding) creates someone; you can give them a password
  or send an invite email so they set their own. Resending an invite cancels the old link.
- A profile shows contact details, pay (managers and up), documents, time off, attendance,
  reviews, training, tasks and a **Clock in** box. Buttons at the top include Notifications and
  resetting two-factor.
- Phone numbers are formatted as (555) 555-5555 automatically.
- Marking someone inactive or terminated (with a reason, visible to managers) signs them out.
- **Pay History** (on the profile, managers see it, admins change it): every pay rate with the date
  it started. **Add a raise or pay change** with the date it starts (today, a past date or a future
  date). Payroll pays each day at the rate in effect that day, so earlier pay periods keep the old
  rate and a raise in the middle of a pay period is split. A future raise takes effect on its day.
  Editing the pay rate in the profile form also records a change, starting on the date in
  **If pay changes, it starts on**. Remove an entry only if it was a mistake.

## Shifts

The **Shifts** page (Team side of the menu) is the work schedule.


- The week grid: one row per person plus **Open shifts** (anyone can claim them). Change the week
  with the calendar drop-down at the top.
- **Week / Month** (top right) switches to a **month calendar**: each day lists its shifts (start time
  and who), open shifts, time off (🌴) and paid holidays (🎉); your own shifts are outlined, drafts
  dashed. ‹ › and **Today** change the month; the Filters box applies too. Click a shift to edit it
  (managers) or pick up an open shift; click the **+** in a day to add a shift there; click a date
  to open that week in the week grid. **Change or delete shifts** works here too and starts with the
  month you're looking at. The choice is remembered on that computer.
- **📅 Subscribe in calendar** (Shifts page, everyone): a private link that puts your published
  shifts, approved time off and paid holidays in your own calendar: **Add to Google Calendar**,
  **Open in Apple Calendar / Outlook**, or **Copy link** (Google Calendar: **Other calendars + → From
  URL**). **Reset my link** stops an old link working.
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
- Employees can claim open shifts. To be off for a scheduled shift, they request time off (**Time
  Off**); shifts can't be dropped from the schedule.
  Part-time staff set **My availability** (times they can't work).
- The **Filters** box searches by name, job title, department, position, job site, vehicle and
  status.
- **Phone app (Schedule → Shifts):** switch between **List**, **Week** and **Month** at the top. The
  week and month calendars show colored dots: blue = your shift, green = an open shift you can pick
  up, grey = approved time off, purple = paid holiday (today is circled). Tap a day to see its
  shifts underneath, with **Pick up this shift** on open shifts (to be off, request time off). ‹ › change week or month; tap
  the title to jump back to today. **Scheduled hours** totals your week or month and warns about weeks
  over 40 hours. Managers can switch to **Whole crew** and pick a person or **Open shifts**.
- **Subscribe in Calendar** (phone app, under the shifts): adds your published shifts, approved time
  off and paid holidays to your phone's calendar: **Add to iPhone Calendar** on iPhone, **Add to
  Google Calendar** (on Android and iPhone; Google Calendar asks you to confirm, sign in with the
  Google account your phone uses), or **Share link** for anything else. It updates by itself, about every hour. The link is private to you;
  **Reset my link** stops an old link working (then subscribe again). Draft shifts never appear.

## Time Clock

- Clock in and out on the website, the employee page's Clock in box, or the phone app (with GPS).
- Managers see who's on the clock now and weekly timesheets with overtime, can fix or add punches,
  and approve time.
- **Job sites & location rules:** set separately for clocking in and clocking out: Optional,
  Required, Required and flag if away from a job site, or Required at a job site. To add a job
  site, type the address and click **Find on map** (or paste a Google/Apple Maps link, type
  latitude, longitude, or use your current location), check it on the map, then **Add site**.
- **Location tracking (phone app):** location must be on and allowed to use the Crewdesk app; if
  it's off, the app shows **Location is required** with a button to allow it or open Settings
  (choose **While Using the App**). The app records where the phone is when clocking in and out, and
  every 5 minutes while the person is clocked in with the app open. Nothing is recorded off the
  clock or while the app is closed. Points are kept for 180 days.
- **Location trail** (managers): on **Time Clock**, click **trail** next to someone in **On the
  Clock Now**, or **Location trail** on one of their entries. A map shows the day's route: green =
  clocked in, blue = every few minutes, red = clocked out (hover a dot for the time); change the
  **Day** to look at another date, and open the list for exact times and links to Google Maps.
  Gaps mean the app wasn't open or had no signal. Some states (for example New York, Connecticut
  and Delaware) require telling employees in writing that their location is monitored; add it to
  your handbook or onboarding documents.

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

- **Review Program** (the box at the top, managers and up): lists who needs a review, with the
  due date and **Overdue** / **Due soon** status; tick **Show upcoming** to see later ones.
  **Start review** opens a new review with the person and review type filled in.
- **Set up review program** / **Edit program** (owners and admins): turn it on, then add, change or
  remove reviews. For each one: a name, the review type, **When** (once, X days after hire, like a
  90-day review; or repeating every X months, counted from the hire date, from their last review of
  that type, or from a set date for everyone), **Remind X days before**, which employment types it
  applies to (none ticked = everyone) and **Active**. **While overdue, remind again every X days**
  (blank = once). **Use the standard program** restores the 90-day and annual reviews.
- Reminders go to the person's manager and to owners/admins who manage reviews (under **Reviews**
  in notification settings) when a review is due soon and again while it's overdue. Clicking one
  opens a new review for that person. Writing a review of the matching type, dated up to 60 days
  before the due date or later, marks it done. People need a hire date on their profile. Reviews
  that were due before the program was first turned on aren't chased.

## Training

Courses with lessons and quizzes, assigned to people with due dates; progress tracking and
reminders. Managers create and assign courses.

## Documents

Company-wide, per-employee and per-asset documents, with e-signatures. Filters by category, who it
belongs to, signature status and date.

In the phone app, the **📄 Documents** button on the **Me** tab opens the Documents page: your own
documents and company-wide ones (everyone, including managers, sees only theirs there). Tap one to
open it. Documents waiting for your signature appear in **Needs your signature** (on the Me tab and
at the top of the Documents page): tap **1. Read it** to open the document, then **2. Sign**
(signing is only possible after opening it). Search and a **Needs a signature** filter appear when
the list is long.

## Pay & Tax Forms

Employees fill out W-4, I-9 Section 1 and direct deposit online; admins complete I-9 Section 2 and
see what needs entering in payroll.

Employees and managers open it from **Pay & Tax Forms** in the left menu. Owners and admins open it
with the blue **Pay & Tax Forms** button at the top right of the **Payroll** page (**← Back to
Payroll** returns).

## Onboarding

New-hire checklists (check off, upload and sign tasks), invite emails, and a list of what's waiting
on managers.

## Hiring

Job postings, a public careers page, an applicant board, and one-click hire.

## Payroll

- **Pay schedule:** how often you pay, when periods start, payday, and who approves (owners and
  admins). Pay periods show on a calendar.
- **Payroll Approval** (the blue button at the top right of the **Payroll** page; approvers who
  aren't admins get a **Payroll** link in the left menu that opens it; the yellow number is how many
  are waiting): review everyone's hours when a pay period ends and approve them before payday.
- **Export hours** for a pay period (CSV) and **Timesheets to approve**. When someone's pay changed
  during the period, the line says so (for example "$18.00/hr, then $20.00/hr from Mar 4") and the
  estimated gross uses each day's rate. In a week with two rates, overtime uses the blended
  (weighted average) rate, as federal law requires.
- **Extra Pay** (bonuses, commissions, reimbursements, other pay; owners and admins add it,
  managers can see it): on the **Payroll** page, the **Extra Pay for …** box below the hours
  table (**Add extra pay**: type, amount, date, note, and who: one person or tick several, with
  **Select all shown**), or on an employee's page in their **Extra Pay** box. It goes in the pay
  period its date falls in. Bonuses, commissions and other pay are added to the estimated gross;
  reimbursements are listed but not counted as wages. The CSV has Bonus, Commission, Other Pay and
  Reimbursements columns. Extra pay dated in an approved pay period isn't included until that period
  is reopened and approved again. **Remove** deletes an entry made by mistake.
- **Approved pay periods are locked:** their figures are saved when approved, so a later raise or
  correction doesn't change them (you'll see a 🔒 note). To recalculate one, an admin clicks
  **Reopen for approval**, then it's approved again.

## Accounting

Connects to Bigcapital (the company's accounting system). Approved pay periods can post as journal
entries (wages, bonuses and commissions to the wages account; reimbursements to the reimbursements
account if one is chosen) and completed repair orders as expenses, automatically or by hand. Set up the connection and
accounts in **Settings → Integrations** (payroll admins).

To work in Bigcapital itself, click **Accounting** under Payroll in the Team menu; it opens Bigcapital in a
new tab (until Bigcapital is connected, the link opens Settings → Integrations instead).

## Assets (Vehicles & Equipment)

- The fleet list with maintenance status; click an asset for details: meters (odometer, engine
  hours), documents, QR label, repair orders, inspections and **Preventive Maintenance Schedules**.
- **Add schedule** opens the form (it turns into **Cancel** while open); **Save schedule** saves it:
  service name, every X miles / engine hours / days (whichever comes first), last
  service, **Assign to** (they get its reminders and repair orders made from it), optional
  **Remind … before** timing and **Notes** (oil type, part numbers, which shop…). Notes show under
  the service name; **Add note** / **Edit note** changes them later. **Create repair order** turns a
  due service into a repair order (its notes go in the repair order's description).
- **Reminder settings** (top of the Assets page): company default for how far ahead "due soon"
  reminders go out (miles, engine hours, days; blank = 10% of the interval) and an optional repeat
  every N days while overdue. Each schedule can override this with **Change** in its Reminder
  column.
- **Maintenance History** (on each asset's page): every completed repair order and service, newest
  first, with the date, repair order number, what was done and notes, mileage / engine hours at the
  time, who did it and the vendor, and parts, labor and total cost. **Filters**: search (service,
  part, vendor, notes, repair order number, who did it), type (scheduled service, repair, from an
  inspection) and a date range; the totals update to match. **Export CSV** downloads what's shown
  (for a spreadsheet, resale or warranty records); **Print** opens a printable copy. **Add past
  service** (fleet managers) records older work, e.g. from paper records or receipts: what was done,
  date, odometer, hours, vendor, costs, notes, and optionally which schedule it was for (a newer one
  resets that schedule). Click a repair order number to open it, for example to correct its costs.
- **Fuel** (on each asset's page): **Log fuel** after each fill-up: date, fuel (Gasoline, Diesel,
  **CNG**, Propane, DEF, Other), amount (gallons, or GGE for CNG, as the CNG pump shows), price per
  gallon or total (enter any two and the third fills in), odometer and/or engine hours, station,
  **Filled to full**, notes and a receipt photo or PDF. The odometer/hours also update the asset's
  meters, which keeps mileage-based maintenance reminders current. The box shows fuel cost, gallons,
  average price, **fuel economy** (MPG, or gallons per engine hour for equipment) and fuel cost per
  mile or hour, with **Filters** (search, fuel type, dates), **Export CSV** and **Print**. Economy
  uses full fill-ups with a meter reading (miles since the last full fill ÷ fuel added), so tick
  **Filled to full** when you fill up all the way; DEF isn't counted as fuel. Whoever logged a fill-up
  can fix or remove it for 24 hours; fleet managers any time. **Receipt** opens the receipt.
- **Phone app:** **Log fuel** on the asset (from My vehicles or by scanning its QR label): tap the
  fuel type, enter gallons (or GGE) and the total, the odometer, and take a photo of the receipt.
- **Total Cost of Ownership** (on each asset's page): purchase price + all maintenance + all fuel,
  and the cost per mile (or engine hour) and per year since it was bought, plus what it costs to run
  (without the purchase price). Add **Purchase price**, **Purchase date** and **Odometer / Engine
  hours at purchase** with **Edit** on the asset.
- **Fuel & Costs** (blue button at the top of the Assets page, fleet managers): every asset for a
  period (this month, last month, this year, last 12 months, last year or custom dates): fuel used
  and cost, average price, fuel economy (and its usual), maintenance, total, miles or hours run,
  cost per mile or hour, and lifetime cost of ownership. Search, sort and **Export CSV**. Assets
  whose fuel economy is 15% or more worse than usual are flagged; check for maintenance problems or
  fuel going elsewhere.
- **Registration & insurance renewals:** enter each asset's **Registration expires** and
  **Insurance expires** dates (**Edit** on the asset). Reminders to renew go out before each date
  (default 30 and 7 days before) and again after it expires (default every 7 days) until the date is
  updated, so enter the new expiration date once it's renewed. The asset page shows **Expires in X
  days** (yellow) or **Expired** (red) under each date. **Reminder settings** (top of the Assets
  page) → **Registration & Insurance Renewals** (owners and admins): the days before (one or more,
  e.g. 60, 30, 7), how often to repeat once expired (blank = once), and **Who gets them** (tick
  people, e.g. the office manager; none ticked = everyone who manages the fleet).
- **Print QR labels:** scanning a label with any phone camera opens a page to inspect, log a
  reading or report an issue.

## Repair Orders

- **New repair order** (managers) or **Report an issue** (everyone): asset, title, priority,
  description, assign to, and when it's due: a **date**, **mileage** and/or **engine hours**
  (whichever comes first).
- The **Due** column shows Upcoming / Coming due / Due now with how far off it is. The assignee and
  fleet managers are reminded as it comes due and when it's due.
- Click a repair order to update status, assignee, due point, labor, parts cost, vendor and notes.
  Completing one linked to a schedule resets that schedule. Critical issues take the asset out of
  service until completed.

## Inspections

Pre-trip / pre-use checklists, mostly done in the phone app. Any failed item opens a repair order
automatically.

## Phone app

Location is required to use the app (it's recorded at clock in/out and every 5 minutes while
clocked in with the app open). Clock in and out, schedule and open shifts, time off, assigned vehicles, meter readings, fuel (with receipt photos),
inspections, issue reports, repair orders, training, onboarding tasks and signing documents.
