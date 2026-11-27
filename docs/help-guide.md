# Crewdesk user guide

This guide is what the Help assistant answers from. Keep it in plain language and up to date when
features change. Menu names are written as they appear in the top bar and the left menu.

## Getting help

The blue **Help** button at the bottom of the left menu opens the **Help window**. It pops up in the corner over
whatever page you're on and **stays there as you move from page to page**, so you can follow its steps while you
work. Press **Help** again (or the **✕**) to put it away; pressing Help always starts at its first screen.

- **The first screen** greets you and has two things: **Ask a question**, and **Search the User Manual** with a few
  popular sections under it. Your most recent conversation, if there is one, sits on top to pick up again.
- **Help** (the left tab): your conversations with the **Crewdesk Assistant**. Press **Ask a question**, type what
  you're trying to do ("How do I move work on the dispatch board?") and it answers with the steps, using this
  manual. Under an answer, **From the User Manual** lists the sections it used; click one to read it. Ask follow-up
  questions in the same conversation. Conversations are kept on this computer (the last 20), and the trash can at
  the top deletes one.
  - The assistant explains how Crewdesk works. It can't see or change your company's records, and it can be
    wrong, so check anything important.
  - It needs to be turned on once (an Anthropic API key on the server; your Crewdesk admin does this). Until it is,
    asking a question shows the closest part of the User Manual instead.
- **User Manual** (the right tab): this guide, a section to a line. **Search** finds the parts that have every word
  you type, and opening one shows **the part that matches** first, then the whole section. The arrows at the top
  make the window larger for reading, and **Open the full User Manual page** shows it as a page.
- The **‹** at the top goes back a step. On a phone the window fills the screen.
- The full-page version is still there: **Help** in the menu under your initials (top right) opens the Help page,
  with **Ask the Assistant** and **User Manual** tabs.

## Finding your way: Operations and Team

Every page has a **top bar**, and a **left menu** for the side you're on.

- **Top bar** (laid out like Homeworks, left to right): the **menu button** (shows or hides the page names in the
  left menu); your company's **logo**, or its name until a logo is added in **Settings → Company Info** (click
  it for the home page); the **Operations | Team** switch; the **weather** icon; **Search** in
  the middle (click it or press **Ctrl+K**, **⌘K** on a Mac); the **phone**, **Text** and **email** icons;
  **Clocked out** / **Clocked in** (click to clock
  in or out after a quick "are you sure?"; it shows how long you've been on and follows your company's location
  rules like the Time Clock page); **To-dos**; the **Notifications** bell; **+ New**; and your initials.
- **Weather** (left of Search, for everyone): the icon shows this hour's weather and temperature at your business
  address. Click it for the **National Weather Service's forecast**: any warnings or advisories in effect (red or
  amber, at the top), this hour's wind, chance of rain and humidity, the next twelve hours (temperature, wind
  speed and the direction it comes from, chance of rain), and the week ahead, a day to a line. Click a day for
  the Weather Service's full wording. At the bottom are links that open in a new window: the Weather Service's
  own **7-day forecast**, **Hourly graph** and **Radar** for your spot, and under **More weather** the sites
  your company has listed.
  - The owner lists those in **Settings → Company Info → Weather links** (a name and a web address each; drag
    them into order; up to 12). **Edit links** in the box goes there.
  - The forecast is for the **business address** in Settings → Company Info. When that address can't be placed
    on a map (or there isn't one yet), Crewdesk uses the next best thing and says so under the forecast: in the
    **test company**, where your real company is; otherwise the middle of the properties you work at, or your
    town or ZIP code. Only with none of those does the box ask for the address.
  - Crewdesk asks the Weather Service every 15 minutes at most; if it can't be reached, the last forecast
    shows, marked as such.
  - A red dot on the icon means a warning or advisory is in effect.
- **Phone** (right of Search, for the people who answer texts): click it to open **Talkroute's desktop app**.
  It opens your computer's calling app, so set Talkroute as the default app for calls once (Windows: Settings →
  Apps → Default apps → search **TEL**; Mac: FaceTime → Settings → **Default for calls**), and tick "always
  allow" the first time your browser asks.
  - **The caller box:** when a call comes in to your Talkroute number, a box pops up under the phone icon on
    whatever page you're on: the customer's name (or "Unknown caller" and the caller ID), their number and
    service address, and how the call went (**Answered** and how long, **Missed call**, or **Left a voicemail**
    with its words). **Open customer** goes to their page, **Call back** dials them in Talkroute, **Text** opens
    the conversation. It stays until you close it (✕), up to four at a time, newest on top.
  - Talkroute tells Crewdesk about a call **when it ends**, not while it's ringing. So the box appears a few
    seconds after the caller hangs up or goes unanswered. While the phone is ringing, the caller's name shows
    in Talkroute's own app; **Copy customers to Talkroute** (Settings → Integrations) puts your customers' names
    there. Calls need to be reported for any of this: Settings → Integrations shows whether they are.
- **Text** (right of Search, for the people who answer texts): opens the Text page; the red number is how many
  conversations have something unread.
- **Email** (right of Search, for Customers & billing managers): opens **Resources → Templates** on its
  **Sent / History** tab: every email Crewdesk has sent, with the email templates one tab over.
- **To-dos button:** the red number is how many of your to-dos are due today or overdue. Click it to see them,
  tick them off, add one (**+ New to-do**) or open the To-dos page (**View all**).
- **Search:** click it before typing for quick links (Customers, Team, Shifts and Account settings). Then type and
  the matches drop down under the box, grouped:
  - **Customers** (name, email, phone or customer number) and **Properties** (street, property name or ZIP);
    **» See all customers…** opens the Customers list already searching for what you typed.
  - **Invoices** by number (**1043**, **#1043** or **inv 1043**) or PO number, with the customer, total and status.
  - **Payments** by check or reference number (**4417** finds "Check 4417", the invoice it paid and who paid it).
  - **Price list** services by name.
  - **People** by name, **Fleet** assets by name, make, model, plate or VIN, and **Repair orders** by number
    (**RO 12**) or title. Opening a repair order shows it on the Repair Orders page, even if it's completed.
  - **To-dos** you can see, by title or location (a repeating one shows once).
  - **Pages** you can open, by name.

  Customers, properties, invoices, payments and the price list only show for people with Customers & billing
  access. Arrow keys and Enter work too; Esc closes it.
- **Notifications bell:** the red number is unread items. Click it to see your new notifications; click one to
  open what it's about (it's marked read). **Mark all as read** clears them; **View all** opens the full list.
- **+ New:** everything you can add, in columns like Homeworks: **Team & Resources** (Employee, Time off request,
  Product & service, Equipment), **Finance** (Invoice), **Events** (Work order, To-do, Repair order) and **Customer** (Customer,
  Property). Each opens its page with the add form showing; you only see what your access allows.
- **Your initials:** My profile, Company Wiki, Notification settings, Security, All settings, Help, **Open** the test
  company (or **Back to the real company** when you're in it) and **Sign out**.
- **Breadcrumb trail:** at the top of every page, the last pages you visited, oldest first, ending with the page
  you're on (in bold), such as **Jane Example / Invoice 1043 / Price list / Invoices**. Click one to go back to
  it. It shows your last three pages before this one; opening a page that's already in the trail moves it to the
  end. The trail is yours alone, kept in this browser (the test company has its own).
- **Light or dark mode:** at the bottom of the left menu, like Homeworks. With the menu open there are three icons:
  sun (**Light**), moon (**Dark**) and screen (**Auto**, which follows your phone or computer's own setting and
  switches with it). With the menu narrow, click the button under Help and pick one. Crewdesk remembers your
  choice in that browser (other people and other computers keep their own). The customer portal follows the
  customer's device.
- **Left menu:** one icon per group. Point at (or click) a group to see its pages; groups with one page open
  straight away. **Company Wiki**, **Settings**, **Help** and light or dark mode are at the bottom. The top bar's menu button widens
  the menu (click it again to narrow it); Crewdesk remembers your choice on that
  computer. Widened (and on a phone), each heading opens and closes its pages, like Homeworks: click **Billing** to
  see Invoices, Estimates and Sales tax report, and click it again to fold it away. The section you're in starts
  open, and the menu remembers which ones you opened or closed.
- **Operations:** **Customers** (Customers, Properties), **Schedule** (Calendar, Work orders, To-dos), **Billing** (Invoices,
  Estimates, Sales tax report), **Resources** (Products & services, Chemical Tracking, Custom fields, Tags, Templates, Automations, Documents, Visit Forms, Text), **Field**
  (Property Measure, Spray Mix Calculator), **Fleet** (Assets, Repair Orders, Inspections), **Reports**
  (managers) and, last, **Marketing**.
- **Marketing** (the megaphone, under Reports) is being kept for what's coming: your website and other marketing
  tools. It has nothing of its own yet. Templates, Automations, Documents, Visit Forms and Text used to be here
  and are under **Resources** now, working exactly as before; the Marketing page has a button to each in case
  you go looking.
- **Team:** **Dashboard** (managers), **People** (Team, Shifts, Crews, Time Clock, Attendance, Time Off, Reviews &
  Discipline, Training, Documents, Onboarding, Hiring), **Pay** (Payroll, Accounting, Pay & Tax Forms) and
  **Reports** (managers).
- **On a phone:** the menu button at the top left opens the menu, with the Operations | Team switch at its top
  and Wiki, Settings and Help at the bottom; search (opens full screen), the clock, notifications, **+** and your
  initials stay in the top bar as icons.
- Opening a page (or a link someone sent) switches to that page's side by itself, and the menu remembers the
  side you used last on that computer.
- **Reports** on each side lists the reports you can see there, such as Fuel & Costs, Repair Orders and
  Inspections (Operations), or Attendance, Timesheets, Time Off, Training Progress and Payroll (Team).

- **What does this button do?** Rest the pointer on any button for half a second and a small dark box says what
  it does: "Download this list as a spreadsheet file (CSV)" on **Export**, "Move the whole day's open work…" on
  **Rain or wind day…**, and so on. It works on the icons in the top bar and the left menu too (each page in the
  menu says what it's for), on tabs and filter chips, and on column headings (which say they sort). Move straight
  to the next button and its description shows at once. In a menu the description sits beside the menu, so it
  never covers the next choice. With a keyboard, **Tab** to a button to see it; **Esc**
  or clicking puts it away. Phones and tablets have no pointer to rest, so they don't show these.
- **Putting a list in order:** wherever a list has an order you can change (services on the price list,
  reasons for going inactive, custom fields, job titles and departments, training lessons, application methods, spray
  mix products, and the columns of the Customers, Waiting list and Dispatch pages), each row has a **handle of six
  dots**. Drag the row by it with the mouse or a finger and let go where it belongs; the order is saved when you
  let go. With a keyboard, tab to the handle and press the up or down arrow.

## Roles and access

- **Roles:** Owner, Admin, Manager, Employee. Owners can do everything. Admins manage people, pay
  and settings. Managers run schedules, approve time and time off, and manage the fleet. Employees
  see their own information and do their own tasks.
- **Settings → Permissions** (owners, and anyone given "manages permissions") sets, area by area,
  what each person can do: no access, view, manage, or admin. **Settings → Layout Editor → Role
  access** sets the defaults for each role.
- Some menu items only appear for the roles that can use them (for example Payroll for
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
- **Company Info:** company name, logo, address (separate boxes), phone, email, website, time zone. Once a
  **logo** is uploaded it takes the place of the company name at the left of everyone's top bar (remove the logo
  and the name comes back). A transparent PNG looks best; a logo with dark lettering on a see-through background
  is set on a white plate so it can still be read on the dark bar.
  - **Upload the logo at any size.** Crewdesk fits it for you: it **trims the blank border** around the artwork
    (see-through, or the plain white or colored background it was saved on), so the logo fills the room it's
    given instead of sitting small in the middle, and saves it at two sizes: one for **print and emails**
    (invoices, estimates, letters; up to 800 × 400) and a smaller one for **screens** (the top bar, the customer
    portal, the header of plain emails; up to 480 × 160). It is never enlarged, so start from the largest copy
    you have; the line under the buttons says what was saved, and warns when the result is small enough to look
    soft.
  - A logo added before Crewdesk did this shows a **Fit this logo** button, which does the same to the logo
    that's already saved. Uploading the original file again gives a sharper result.
  - **Weather links** (owner): the other weather sites listed in the top bar's weather box. See **Weather**
    under "Finding your way".
- **Layout Editor** (owner): drag boxes and fields to rearrange pages, hide items, edit drop-down
  menus (job titles, departments and so on), set **Role access**, and edit the **User Manual**
  (**Edit the user manual**: change anything or add company procedures, check it on **Preview**,
  then **Save the manual**; **Reset to the standard manual** undoes all edits). Help and the
  assistant use the edited copy. When Crewdesk's standard manual is updated, a notice offers the
  **Standard manual** tab so you can copy in what's new.
- **Permissions:** per-person access by area, with search and filters.
- **Customers** (admins in Customers & billing): the tag list and the reasons for going inactive (see Customers & Properties).
- **Integrations** (payroll admins): connections to other systems; today, **Accounting (Bigcapital)**.

## Notifications

The **Notifications** bell in the top bar shows your new alerts in a pop-up (the red number is how many are
unread); **View all** there, or the Notifications page, has the full inbox. Phone pop-ups need the Crewdesk app installed and signed in.

## My Day

The first page on the **Operations** side, and where Customers & billing managers land after signing in, like
Homeworks' My Day.

- **Account standing:** **Past due** (what's owed on invoices past their due date), **Outstanding** (owed, not yet
  due), **Credit** (unused credit on customers' accounts) and **Paid** (money received in the date range below,
  including prepayments). Each tile opens that list.
- **Job stats:** work orders dated in the range you pick (today, this week, last 30 days, this month, this year,
  a custom range and more; it remembers your pick on this browser). **Total jobs**, **Yet to start**,
  **In progress** and **Completed**; skipped ones aren't counted. For a single day the tiles open the calendar on
  that day.
- **Lists:** automations waiting in review, upcoming to-dos (with how many are overdue), today's work orders, recent
  payments, invoices and estimates, each with a link to see all. Unread texts from customers show at the top right
  when there are any.
- **Estimates waiting on an answer:** how many are sent (or have changes asked for) and not yet answered or expired,
  what they come to, how many run out this week and how many haven't been opened. The list shows the ones that run
  out soonest first, with days left.

### Email deliverability

The **Email deliverability** box on My Day shows whether your email is set up to land in inboxes rather than spam,
and which customers can't get it.

- **Sending setup:** the address mail is sent from and the mail service it goes through. Then three DNS records on
  the sending domain (the part after @), which inboxes like Gmail and Yahoo check:
  - **SPF** lists the servers allowed to send for the domain. There must be exactly one SPF record. Your mail service
    gives the line to add, e.g. `v=spf1 include:<your mail service> ~all`.
  - **DKIM** is a signing key your mail service gives you to publish. Crewdesk looks under the usual names; if yours
    uses another, it can be added to the server settings (DKIM_SELECTOR).
  - **DMARC** tells inboxes what to do with mail that fails the checks. Start with
    `v=DMARC1; p=none; rua=mailto:<your address>`, then move to `p=quarantine` once everything passes.
  - These are added where the domain's DNS is managed (for prospray.net, wherever the domain was bought or hosted).
    Changes can take a few hours to show; the box checks again every hour.
- **Last 30 days:** emails to customers (and their contacts) that the mail service took, and any it refused, with
  the reason. "Took" means it left Crewdesk; a mailbox can still bounce it later.
- **Customer addresses:** active customers' addresses that can't get email: not a complete address, an obvious slip
  (e.g. @gmial.com), or a domain that takes no email. Click a name to fix it. Also how many unsubscribed (they still
  get invoices and receipts) and how many get invoices by email but have no address.
- Crewdesk keeps a log of what it sends (who to, the subject, and whether it went) for six months for this box.

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

- **Customers** (Operations → Customers), laid out like Homeworks' Customers page but compact:
  - **Header row:** the **Customers | Properties** tabs, **Export** (a spreadsheet of every matching customer, with
    the columns you show, in your order), **Print**, **⋯** (sample customers, the test company, custom fields)
    and **+ New** (customer, lead or property).
  - **Status tabs with counts:** **Customers**, **Leads**, **Inactive**, **All**. They replace Homeworks' big
    boxes, and the counts follow your search and filters.
  - **Quick search:** name, phone, email, service address or customer number.
  - **+ Filter** (Homeworks' filter box): pick a field, a comparison and a value, e.g. "Balance owed · more than
    · $50", "Tags · has any of · MAP 100", "Last service · on or before · Dec 31", or "A service · Core aeration ·
    completed · from Apr 1".
    - Fields: name, customer #, status, type, tags, lead source, customer since, email, phone, invoice delivery,
      service address, city, ZIP, number of properties, balance owed, overdue, account credit, prepaid balance,
      billed this year, tax exempt, PO required, last service, next service scheduled, any service (completed,
      scheduled, invoiced or never), and your customer custom fields.
    - Add as many as you like; a customer has to match them all. Each shows as a chip: click it to change it,
      **✕** to remove it.
  - **Views ▾:** ready-made views (Owes money, Overdue, Nothing scheduled, Not serviced this year, Never
    serviced, New this month, Unused credit or prepaid). **Save this view…** keeps your status, search, filters,
    sort and columns under a name. Your views are kept in this browser.
  - **Columns:** choose from about 25 columns (Homeworks offers 9), grouped (Customer, Contact, Address, Money,
    Service, custom fields) with a search.
    - **Drag a column's name** up or down to set the order (on a phone or tablet too; with a keyboard, the up and
      down arrow keys move the one you're on), **✕** hides one, and **Reset** goes back to the usual nine.
    - **The box opens down or up**, whichever side has the room to show all of it, so you don't scroll inside it.
      On a window too short to hold it, it uses the window's full height and only then do its lists scroll. (The
      Columns boxes on the Waiting list and Dispatch pages do the same.)
    - Your choice is kept for you in this browser.
  - **Sorting:** click a column heading to sort by it, and again to reverse.
  - **Selecting:** tick customers (or the box at the top for the whole page) to **Add tag**, **Remove tag**,
    **Change status**, **Export selected** or **Print selected**.
    - When the whole page is ticked and more customers match, **Select all N matching** picks every customer the
      tab, search and filters match (up to 5,000), not just this page. **Just this page** goes back.
    - **Change status → Active** or **Lead**; customers already inactive are left as they are.
    - **Change status → Inactive…** asks for a reason (and a comment if the reason needs one) and an optional
      effective date, the same as making one customer inactive. Each one gets that reason, and properties
      they're the current bill-to for are made inactive too. Anyone already inactive is skipped. Reactivate
      from the customer's page.
  - **Pages:** 25, 50, 100 or 250 rows a page, with Previous and Next.
  - **Send ▾** (top right, or in the bar when customers are ticked) goes to the ticked customers, or, with nothing
    ticked, everyone the list shows (tab, search and filters).
    - **Email…** opens a short form: a subject and message, with **Insert** buttons for fill-in fields like
      {first_name}, {balance}, {next_service} and {company}. The right side shows the email filled in for the
      first customer. It shows how many will get it and who's skipped: no email address, unsubscribed, sample
      customers, and a second customer with the same address (each address gets it once). A misspelled field
      like {frist_name} is pointed out.
    - **Template** (top of the form) sends one of your designed emails from **Resources → Templates** instead of
      a typed message: pick it and the right side shows it filled in for the first customer, as designed. Your
      company details and an unsubscribe link go underneath, as always. A template with fill-ins about one
      invoice or estimate is flagged, since those are blank in an email to a list.
    - **Send me a test** emails it to you first. **Send to N customers** sends it; this can't be undone.
    - **Document: email or print letters…** sends a document from Resources → Documents (a price increase letter,
      a thank you…) to the same list: pick the document, see it filled in for the first customer as an **Email**
      or a **Printed letter**, then **Email N customers**, **Print letters for all**, or **Print letters for the
      ones email can't reach** (no email address, or unsubscribed). See *Documents* below.
    - The emails go out one at a time in the background (about four a second), from your company name, with
      replies going to your company email. Each has your company's name, address and phone and an
      **Unsubscribe** link at the bottom. Customers who unsubscribe still get invoices and receipts.
    - **Text N customers…** (once texting is connected) writes one text that goes to each of them from your
      Talkroute number, a few a minute, with tags filled in for each. Before texting is connected it's **Text: copy
      phone numbers…**, which lists the customers' numbers (each once) to copy or download.
  - **Bulk emails** (the tab next to Properties) lists every email sent this way, with how many were sent, didn't
    go (and why) or were skipped. Open one to see each customer, or **Stop sending** while it's still going.
    A customer's page shows the emails they were sent and whether they've unsubscribed (with **Resubscribe** if
    they ask to be put back on). The **Unsubscribed from emails** filter and **Unsubscribed** column find them.
  - The address in the browser keeps the tab, search, filters, sort and page, so **Back**, refreshing and sharing
    the link all bring the same list up.
- **Add customer:** Residential, Commercial or HOA (commercial and HOA accounts are listed by company name),
  contact details, billing address, how invoices are sent (email, paper, text; any of them), how they heard
  about you, tags, notes and **Other contacts** (a spouse, property manager or accounts payable; tick **Copy on
  invoices** for anyone who should get a copy). Commercial accounts can be marked **Needs a PO number**. Tick
  **Add their service address now** to create their first property with them as bill-to (or untick **Service
  address is the billing address** to type a different one). Choose **Lead** for someone who hasn't bought yet.
- **Customer page**, laid out like Homeworks':
  - **At the top:** **Edit**; **Send ▾** (**Email…** writes them an email with fill-in fields and a preview;
    **Text…** shows their number to copy); **Create ▾** (work order, payment, estimate, invoice, to-do,
    property); **⋯** (print the page, view as customer, make inactive or reactivate, delete).
  - **Tabs:** **Customer details**; **Communication** (call notes and the timeline, which you can narrow to
    notes and calls, emails, estimates, payments, work orders or account changes, plus emails sent to many
    customers); and **Photos & documents** (drop in photos, PDFs or short videos, up to 25 MB each).
  - **Left column:**
    - **Main info**, with **Show more** for customer #, other phone, county, how they heard about us, customer
      since, tax exempt and discount.
    - **Customer notes:** office-only notes you can save right there.
    - **Jobs:** one-time work orders coming up, repeating ones (with how often and what's next), and history.
    - **Properties**, with when each was last serviced and next scheduled.
    - **Estimates**, **Invoices**, and **Payments** (pick a month and year).
    - **Invoice delivery preference** (tick email, paper or text right there), **Custom fields**, **Customer
      stats** (collected, owed, average visit value, work orders done, past-due invoices, last and next
      service) and **To-dos**.
  - **Right column:**
    - The **account box**: past due, outstanding, paid this year, credit and prepaid. **Record payment** picks an
      open invoice. **Show revenue projection** shows what scheduled work brings in today, this week, this
      month or this year.
    - **Call notes:** call or note; tick **Notify someone** to send them a notification, and **Create a
      follow-up to-do** to make a to-do for a day and person. Then the **Timeline** of everything that
      happened with them, newest first.
    - **Cards & bank accounts on file**, **Invoice settings** (days to pay, discount, notes on their invoices,
      PO, sales tax, autopay; **Change** edits them), **Customer portal** (the emails that can sign in, and
      **View as customer**), **Other contacts**, **Prepayments**, **Credits**, when it was made inactive and why, and photos and
      documents.
  - **Their own invoice defaults** (Edit → "Their invoices and estimates"): **Discount %**, **Days to pay** and
    **Notes on their invoices**. New invoices use their days to pay and notes. Invoices made from work orders also
    get their discount. The invoice and estimate forms start with their discount filled in.
- **Properties** (Operations → Properties): search by address, ZIP, label or customer; filter by **Map Code
  starts with** (e.g. 80 for 800–809; type **none** for properties without one), status, property tags, and the
  bill-to customer's tags (e.g. properties whose customer is tagged Commercial).
- **Property page:** the **Property** box and the **People** on it. **Map** opens the address in Google Maps.
- **People on a property:**
  - **Add contact:** someone to reach about the address who is **not a customer**: a tenant, an on-site
    manager, a neighbor with the gate key. The **Add Contact** window opens with **First Name**, **Last Name**,
    **Nickname**, **Contact Type**, **Email**, **Home Phone**, **Work Phone**, **Cell Phone**, **Other Phone**,
    **FAX**, **Form of Contact** and **Birthday**, plus **Moved In** and **Notes**. Only a first or last name is
    needed. They get no invoices and need no account, and nothing is added to your customer list.
  - **Contact Type** is a drop-down of your own choices (Tenant, Property manager, Owner, Spouse, Family member,
    Neighbor, Other to start). The owner changes the list with **Edit drop-down menus** in the layout editor;
    renaming a type renames it on every contact that has it.
  - **Form of Contact** is how they would rather be reached: a phone call, a text or an email. It needs the
    matching detail (a cell phone for a text, an email address for an email).
  - **Receive service notifications for this property:** tick it and the contact hears about the service at this
    address, the same news the customer can get: when a visit here is **scheduled**, **moved to another day** or
    **sent back to the waiting list** (when the office ticks "Notify customers by their preference"), and the
    **notice after a chemical application** (once those are on under Chemical Tracking → Customer notices). It
    goes by their Form of Contact; with none picked, by email, else a text to their cell. Someone reached only by
    phone is not sent anything: they are listed for the office to call. The window says how they will be reached
    before you save.
    - It does not depend on what the customer chose. A landlord can want no notices while the tenant gets them.
    - They never get invoices, statements, estimates, bulk emails or automations.
    - A contact who replies **STOP** to a text gets no more texts until they reply START (or their cell phone
      number is changed). Untick the box to stop everything.
    - The notify box on the waiting list and the dispatch board counts them ("2 property contacts"), and the
      Customer notices log shows who each notice went to.
  - **Change** edits a contact, **Moved out** keeps them in the property's history and stops their
    notifications (**Show history**, where **Bring back** puts them on it again), and **Delete** removes one
    added by mistake.
  - Contacts show on the property's **work orders** (under Where and who, with every phone number and their
    notes), so the office and the crew know who to call or knock for, and the **search box** finds the property
    by a contact's name, nickname, email or any of their phone numbers.
  - **Add a customer** puts an existing customer on the property as a resident, or as the new bill-to: the old
    bill-to's time ends the day before, their past invoices stay with them, and the property's history stays
    with the property. Use it for a landlord, an owner or anyone you invoice. **Moved out** ends a resident's
    time.
- **The Property box:** everything about the property in one box, each piece its own item.
  - **Its details are custom fields.** Map Code, Front Lawn ft, Back Lawn ft, Other ft, Total ft, Gate Code,
    Pets, Access Notes and Notes come with Crewdesk; your own property fields show right beside them. Rename
    any of them, change their order or add more in **Resources → Custom fields** (admins can also click **Add
    custom field** in the box). Crewdesk's own can't be deleted, because it uses them: the gate code, pets and
    access notes reach the crew's phone, the Map Code groups routes, and the sizes price services.
  - **Edit details** turns every field into a box to type in; **Save details** saves them all.
  - **The sizes:** **Total ft** follows Front + Back + Other while you type them. Type your own total and it
    stays as you typed it (that is how you override it). Leave the total blank and it is added up for you.
  - **Property Image:** the property's saved Property Measure, shown as a picture (the aerial photo with the
    measured areas drawn on it). Click **Add image**, find the drawing (the ones for this address come up
    first) and click it. Its sizes go straight into Front Lawn ft, Back Lawn ft and Total ft, and anything
    measured that was marked neither front nor back goes into Other ft. You can still change any of them by hand
    afterwards; the box then says the sizes differ from the image and offers **Use the image's sizes** to put
    them back (use the same link after redrawing the property in Property Measure). **Change image** picks
    another, **Open in Property Measure** opens the drawing, and **Remove image** takes it off without touching
    the sizes. No drawing yet? **Measure this property** in the picker goes to Property Measure.
  - **Tags**, the **Preferred crew**, the **Pre Visit Notification**, how the customer hears **after a chemical
    application**, and the **card on file** switch are in the same box.
  - **In the layout editor** (Settings → Layout editor) every item in the box can be dragged to a new place or
    hidden, like the items in any other box.
- **Adding or editing a property** (the **Edit** button, or **Add a property** on a customer): the address, the
  sales tax rate, **Add image**, the same **Property details** fields and the tags.
- **Inactive customers and properties:** **Make inactive** (in the customer's **⋯** menu, or at the top of a
  property) asks for a reason from the list, an effective date and a comment (required for some reasons, such as
  Other). Making a customer inactive also makes the properties they're the bill-to for inactive; properties
  where they're only a resident are left alone. Inactive records are hidden from everyday lists but kept with
  their history; **Reactivate** brings them back (reactivate each property from its own page). Crewdesk says
  **Inactive** everywhere a record is no longer in use: customers, properties, services, packages, chemical
  products and vehicles or equipment.
- **Tags** (Settings → Customers, admins): add tags with a name, color and description, **Archive** ones no
  longer used (they stay where they are but can't be added), or **Merge** one tag into another. Every tag added
  or removed is recorded with who did it and when.
- **Reasons for going inactive** (Settings → Customers, admins): add, rename, reorder (drag one by its handle, the six dots), mark as the customer's or
  your decision, require a comment, or make a reason inactive so it's no longer offered.
- **Sample customers** (admins, top of the Customers page): **Load sample customers** adds 10 made-up accounts
  plus 2 tenants, tagged Sample, covering the tricky cases (paper invoices, a landlord with tenants, a property
  manager, a PO-number account, an HOA, two properties, a prepay customer and a lead outside the service area).
  Their emails use example.com, so nothing reaches a real person. **Remove sample customers** deletes them all.
- **Deleting:** admins can delete leads, sample customers and customers or properties with no history; anyone
  else is made inactive instead, so the history is kept.

### Billing: price list and invoices

Operations → **Billing** has **Invoices**, and **Resources → Products & services** is the price list (managers in Customers &
billing; admins change prices).

- **Price list:** each service is priced one of four ways: a **flat price**, **per 1,000 sq ft** (with an optional
  minimum charge), **by lawn size** (brackets such as "up to 8,000 sq ft $75, larger $95"), or **per 1,000 sq ft
  with volume discount** (see below). Each service posts to
  an income account (4000 Lawn Treatment Programs, 4100 Pest Control, 4200 One-Time Lawn Services, 4950 Other
  Income). Drag a service by its handle (the six dots at the left) to set the order; **Inactive** services stay on past invoices but aren't offered for new ones.
  The list's **Priced** column says which of the four ways a service uses; hover over it for the prices themselves.
- **Which way to price:** under the **Priced** box the form says in a sentence what the chosen way does.
  - **Flat price:** one price for every lawn, whatever its size.
  - **Per 1,000 sq ft:** the lawn's size times one rate, never less than the minimum. The price rises with every
    square foot: at $6 per 1,000, an 8,000 sq ft lawn is $48 and an 8,500 sq ft lawn is $51.
  - **By lawn size:** you type a fixed price for each size range (up to 5,000 sq ft $60, up to 8,000 sq ft $75,
    anything bigger $95). A lawn pays the price of the first range it fits in. Nothing is multiplied: every lawn in
    a range pays the same, and the price jumps from one range to the next. Use it when you think in a short list
    of prices; use per 1,000 when the price should follow the size.
  - **Per 1,000 sq ft with volume discount:** a minimum, then rates that change at the sizes you set (below).
- **Invoice description:** what customers read on the invoice or estimate line for the service, such as
  "Granular fertilizer with pre-emergent and broadleaf weed control" for a service you call "Round 1". When it is
  empty the service's name is used. Work orders always show the name, since that is what your crew knows it by;
  when a work order is invoiced, a line still carrying the service's name is given the invoice description, and a
  line somebody reworded by hand keeps its words. **Notes for your team** show under the name on the price list
  and never reach customers.
- **Chemical application and its products:** tick **Chemical application** on a service that puts product down;
  it then keeps chemical application records (see Chemical Tracking). People who can open Chemical Tracking get a
  **Products applied** box right there: where it's applied (Turf to start), the products with the rate each goes
  down at, and any mixes, each with optional from/until dates. It is the same list as Chemical Tracking →
  Services, so change it in either place. Those products set the service's material cost and what the tech sees
  filled in when completing the work order.
- **Copy:** each service has a **Copy** button. It opens a new service with everything the other one has
  (pricing, tiers, time estimate, invoice description, taxable and chemical ticks, products and mixes) under the
  name "… (copy)". Change what differs, rename it and save; the original is not touched.
- **Priced from (which property field a service's size comes from):** every service says which of the
  property's number fields its price is worked out from. **Priced from** on the service form lists them: **Total
  ft** (the usual one), **Front Lawn ft**, **Back Lawn ft**, **Other ft**, and any number field you have added
  to properties in Resources → Custom fields (a side yard, a bed area, a count of trees). Add the field there
  first, fill it in on each property, then pick it on the service.
  - **One customer wants it differently** (flea & tick only in the back yard where the dog is): every line for
    a service, on a work order, an estimate or an invoice, has a box under its description showing the field it
    is priced from and that property's number. Pick another field there, or **A size you type**.
  - Changing it re-prices the line straight away and adds a note to the line's wording, such as "Flea & tick
    (back lawn only)", "(side yard only)" or "(3,000 sq ft only)", so the crew sees it on the work order and the
    customer on the estimate and invoice. A line you have reworded yourself keeps your words.
  - Everything worked out from the size follows the line: the **time estimate** on the waiting list, the
    product amounts on the **load sheet**, the amounts the tech sees filled in when completing a chemical work
    order, the **material cost**, and the **area treated** on the chemical record. A whole-lawn round with a
    back-yard-only add-on on the same work order still records the whole lawn as the area treated.
  - A property with nothing in the field has no size for that line: the box says "not on file" and the line
    isn't priced until you fill the field in on the property or type a size.
- **Rate chart:** for per 1,000 and volume discount pricing the form shows a **Rate chart** with every size the
  service prices (every 1,000 sq ft for a single rate; every 500 sq ft, or every step, for volume discount), up to
  the **Price by hand above** size or about an acre. Click its heading to fold it away or bring it back; the
  heading still shows how many sizes it covers and the lowest and highest price, and Crewdesk remembers which way
  you left it.
- **Per 1,000 sq ft with volume discount:** a minimum charge for small lawns, then a rate per 1,000 sq ft that
  steps down as lawns get bigger. It works like tax brackets: **each rate is charged only on the square feet inside
  its own tier**, never on the whole lawn. That is why a bigger lawn can never cost less than a smaller one.
  - **Setting it up:** enter the **Minimum charge**. On the first row, **Minimum covers up to** is the largest lawn
    that pays just the minimum, and **Then per 1,000 sq ft** is the rate for the square feet above that. Each
    further row is **Next tier from** (the size where a lower rate starts) and its rate. A rate applies from its
    own row's size up to the next row's size; the last row's rate goes on for ever. A later rate is usually lower
    (that is the discount), but it can be higher if that is how you price: the form points it out so a typing
    slip doesn't go unnoticed, and a bigger lawn still never costs less.
  - **An example:** minimum $45 covering up to 3,000 sq ft; then $10 per 1,000; from 6,000 sq ft $8; from 10,000
    sq ft $6. An 8,000 sq ft lawn pays $45, plus 3,000 sq ft at $10 ($30, the part from 3,000 to 6,000), plus 2,000
    sq ft at $8 ($16, the part from 6,000 to 8,000) = **$91**. It is not 8 × $8.
  - **Price in steps of:** a new service leaves this empty, so **every lawn is priced at its exact size** and the
    table matches a sum done by hand. Enter a step (say 500 sq ft) to group lawns into steps above the minimum
    (3,001–3,500, 3,501–4,000 and so on), where every lawn in a step pays the same price. **Price each step at**
    says which size in the step sets that price: its middle (fairest), its smallest or its largest. At the
    middle, a 4,000 sq ft lawn is priced as 3,750 sq ft, so the example above gives $52.50 at 4,000 sq ft, not
    $55. At its **largest size**, every lawn in the step pays what the top of the step would, and round sizes
    match the hand sum again.
  - **Round prices to** rounds the result (to $0.50 on a new service). **Price by hand above** stops Crewdesk
    pricing very large lawns on its own: above that size the price has to be typed in.
  - **The rate chart under the form** shows the price at every size as you type, with one lawn worked
    through step by step above it. **Priced as** (shown when steps are on) is the size each price was worked out
    at. **Average per 1,000** is the price divided by the lawn's size; it is
    higher than the tier's own rate because the minimum is spread across the lawn.
- **Packages** (under the price list): saved bundles of line items, like Homeworks' packages: "Spring round" =
  fertilizer + edging + blow-off. Admins add them with **Add package**: pick services from the price list or type
  custom items, with quantity, budgeted hours and price. Leave a service's price blank to price it for each
  property's lawn when the package is added (custom items need a price). On a work order, **Add package…** next to
  **Add line** adds all its items at once; change any of them after. Inactive packages aren't offered; work orders
  already made from a package keep their items.
- **New invoice** (Billing → Invoices, the top bar's **+ New**, or **New invoice** on a customer's page): choose the
  customer and service address, then add lines. Picking a service fills in its price from the property's lawn size;
  you can change any description, quantity or price, or add a custom line. Add a discount (amount or percent) and
  notes printed on the invoice. A PO number is required for customers marked as needing one. Leave the due date
  blank to use your usual terms.
- **Drafts and numbers:** an invoice is a draft until it's sent; it gets its number the first time it's sent, so
  drafts never use up numbers. Drafts can be deleted.
- **Send:** choose **Email** (the PDF goes to the customer's email, or another address you type, and to any contacts
  marked "copy on invoices"; replies go to the company email in Company Info) and/or **Paper** (adds it to the **To
  mail** list). Text delivery comes in Phase 2. **Send again** re-sends a corrected or lost invoice.
- **Paper invoices:** Billing → Invoices → **To mail** lists what's waiting, in ZIP order. **Print selected (PDF)**
  makes one PDF with a cover sheet; each invoice is laid out for a #10 double-window envelope (your return address in
  the top window, the customer's billing address in the bottom one) with a tear-off stub to send back with a check.
  After mailing, click **Mark mailed**. Reprints of mailed invoices say "Copy."
- **PDF:** the **PDF** button on an invoice opens it to print or save.
- **Payments:** **Record payment** for a check (with its number), cash or other payment; the amount starts at what's
  still owed. Part payments mark the invoice **Partly paid**; the rest marks it **Paid**. A payment entered by
  mistake can be voided, which puts the amount back as owed. Card and bank payments come in online (below); they show
  the card or bank (for example "Visa ·· 4242"), Stripe's fee, **clearing** while a bank payment is on its way, and
  anything refunded.
  An invoice paid in full before it was mailed comes off the **To mail** list.
- **Editing and voiding:** a draft, or a sent invoice with no payments, can be edited (send it again afterwards).
  **Void** keeps a sent invoice on record with a reason and stops it counting as owed; void its payments first.
- **Statuses:** Draft, Unpaid, Overdue (past the due date), Partly paid, Paid, Void. The tabs (Open, Overdue, Drafts,
  To mail, Paid, Void, All) and search (invoice number, customer, address, PO) find them; the total due shows at the top.
- **Customer page:** the account box (top right) shows past due, outstanding, paid this year, credit and prepaid;
  the **Invoices** and **Payments** boxes list theirs.
- **Bigcapital (your books):** when Bigcapital is connected (Settings → Integrations), Crewdesk sends billing to it as it
  happens: the customer the first time one of their invoices is sent (and any later changes to their name, email, phone
  or address); each sent invoice with the same number, each line in its service's income account; edits to an unpaid
  invoice; and each payment (cash, checks and other payments to 1020 Undeposited Funds; card and bank payments to 1030
  Card Processor Clearing). Voiding an invoice or a payment removes it from Bigcapital. Drafts never go to the books.
  The invoice page shows **Bigcapital: in the books**, or why it isn't yet; anything that didn't get through (for
  example while Bigcapital was restarting) is retried every few minutes, or click **Send to Bigcapital now**. Settings →
  Integrations lists anything still waiting. Sample customers are only sent from the test company, never to the real
  books.
- **Credits:** give a customer credit for a missed or incomplete service, a goodwill gesture, a billing correction, a
  referral reward or a prepay discount. **Add credit** on the customer's page (the **Credits** box), on a property's
  page (credit only for that property's invoices), or on an invoice. Enter the amount, the reason, and a
  **description the customer sees** ("Missed the back yard on 5/12"); a note for the office is optional. Then choose
  where it goes: **on open invoices now** (oldest first), **kept on the account for the next invoice**, or on one
  invoice. A credit lowers what's owed: the invoice shows it ("Credit CR-3 −$20.00" on the PDF, "Credit: …" in the
  portal), and a fully credited invoice counts as paid. Credit kept on the account goes on the customer's next
  invoice automatically when it's sent (turn that off in Settings → Customers & billing). A property's credit is only
  used on that property's invoices.
  - **On an invoice:** the **Credits** box lists the credit on it; **Take off** puts it back on the account; **Use
    credit** puts account credit on this invoice (choose the credit and amount).
  - **Void** a credit (Credits box on the customer's page) if it was a mistake: it comes off any invoices it was on
    and they owe it again. Voiding an invoice puts its credit back on the account. An invoice with credit on it can't
    be edited until the credit is taken off.
  - **Bigcapital:** each credit becomes a credit note (CR-number) in **4900 Discounts and Refunds**, applied to the
    same invoices; taking credit off unapplies it, and voiding removes the credit note. Credit kept on the account
    shows in Bigcapital as the customer's unused credit.
  - **Customers** see their credit in the portal: on each invoice, and "credit on your account" on the home page.
- **Prepayments:** money a customer pays ahead (a season, some services, or any amount), with an optional prepay
  discount. On the customer's page, **Prepayments → Take a prepayment**: say what it covers (the customer sees it),
  choose a property if it's only for one, then **work it out from services** (pick services from the price list,
  priced for the lawn size, and how many) or **enter an amount**, and the discount (percent or dollars off). Crewdesk
  shows what it covers, the discount and what the customer pays.
  - **How they pay:** **cash**, **check** (with its number) or **other**, received now; or **Send a pay link**: the
    customer gets an email with a link to pay by card or bank account (Stripe must be connected). The link works for
    30 days; **copy** it or **email again** from the Prepayments box. Customers can also **prepay any amount** in the
    portal, and pay a prepay offer from the office there.
  - **Using it:** a paid prepayment pays the customer's invoices as they're sent (a property's prepayment only that
    property's), after any credit. Each invoice gets a **Prepaid (PP-3)** payment for the cash share and, with a
    discount, a "Prepay discount" credit for its share, so the discount is spread over the services it covers. Tick
    **Also pay their open invoices** to use it on invoices already sent. What's left shows on the customer's page,
    the invoice page's Billing box, and in the portal.
  - **Voiding a prepaid payment** on an invoice puts the money (and its discount) back on the prepayment.
  - **The customer cancels** (admins): **Take back discount** charges the full price for what was done, paid from the
    prepayment as far as it goes (anything more shows as owed on the invoices), and no more discount is given. Then
    **Refund the rest**: back to the card or bank account through Stripe, or record how you paid it back (a check
    number) for cash and checks. Or leave the rest to pay future invoices. A refund made in Stripe's dashboard closes
    it too.
  - **Void** a pay link nobody used, or a cash or check prepayment entered by mistake (only before it has paid an
    invoice).
  - **Bigcapital (income when received):** prepayments count as income the day they're received. The money goes
    from Undeposited Funds (cash and checks) or Card Processor Clearing (card and bank) to each covered service's
    income account (price-list services use their own account; for an entered amount, choose the account, 4000 Lawn
    Treatment Programs by default). Each invoice it pays is closed in Bigcapital with a credit note on the same income
    account, applied to the invoice, so the income isn't counted twice. The prepay discount goes to 4900 as a credit
    note, and a refund is a journal taking the refunded amount back out of income.
- **Settings → Customers & billing** (admins): the **next invoice number** (at switch-over, set it to follow Service
  Autopilot's last number), your usual **terms** (due on receipt, net 7/10/15/30), **make checks payable to**, and the
  **footer** printed on every invoice, and whether a customer's credit is **used automatically** on their invoices
  when they're sent (on by default).

### Late fees

Late fees are **off** until an admin turns them on in **Settings → Customers & billing → Late fees**.

- **Steps.** Add up to six steps, each "N days after the invoice is sent, add $X" (or X% of the invoice). For example:
  $15 at 30 days, then 2% at 60 days. Each step is added **once**, as a "Late fee" line on the invoice. It's worked
  out from the **original** invoice total, so fees never pile on fees. The customer's discount doesn't reduce a
  late fee, and it isn't taxed. Late fees post to income account **4950** in Bigcapital.
- **When they're counted from.** Days count from the day the invoice was **first sent**, not its invoice date.
- **Rules are set at sending.** An invoice gets the steps in force on the day it's first sent. Changing the steps
  later only affects invoices sent after that. Invoices sent before late fees were turned on never get them.
- **Paid invoices** get no fee. A bank payment that's still clearing counts as paid.
- **Email.** With **Email the customer** ticked, a customer who gets invoices by email is told when a fee is added,
  with the new balance and a pay link. The office gets a notification listing the fees added.
- **Per customer.** On a customer's page, open **Invoice settings → Change late fees or auto-send**. Choose the
  company default, **No late fees**, or the customer's own steps.
- **Waive.** The invoice page has a **Late fees** box with the steps it got and their dates, plus any fees added.
  **Waive** takes a fee off; it won't be added again. If the customer has already paid the fee, refund or add a
  credit instead. Editing an invoice leaves its late fee lines as they are.

### Auto-sending invoices

Auto-send is **off** until an admin turns it on in **Settings → Customers & billing → Auto-send invoices**.

- **Schedule.** Choose daily (every day, or weekdays only), weekly (pick the days), or monthly (a date such as the 1st
  or the last day, or a weekday such as the first Monday). Also choose the hour it runs.
- **What it does.** On a send day, each customer's **draft** invoices are sent the way that customer gets invoices.
  Customers with an email get them by email with a pay link. Customers set to paper, or with no email, go on the
  **To mail** list. Drafts with a $0 total are skipped.
- **Finished work orders.** With **First make invoices for their finished work orders** ticked, completed work
  orders that aren't on an invoice yet become invoices and go out in the same run.
- **Once a day.** Each company's run happens once a day. A draft made after the run waits for the next send day.
- **Summary.** The office gets a notification listing what went out and anything that couldn't, such as a missing
  PO number.
- **Per customer.** On the customer's page, choose the company default, **Don't send automatically**, or their own
  schedule. An invoice that went out this way shows **Sent automatically** under Delivery.

### Sales tax

Sales tax is **off** until you turn it on, so nothing is taxed today. It's built in so you're ready to sell
products or taxable services later.

- **Turn it on** in **Settings → Customers & billing → Sales tax**: tick **Charge sales tax**, name it ("Sales tax"),
  and set the **Default tax rate** (up to 3 decimals, like 8.625%).
- **What gets taxed:** on the **Price list**, tick **This is taxable** on items like bags of mulch, seed or products
  left with the customer. Lines for those items get the rate; other lines get none.
- **Which rate** (like Homeworks):
  - The **property's** rate (property form: "Sales tax rate here").
  - Then the **customer's** own rate.
  - Then the company default.
  - A **Tax exempt** customer (an HOA, church, school or reseller, with their exemption certificate number) pays
    none.
- **Work orders and invoices** show a **Tax %** on each line while sales tax is on (or when a line already has tax).
  - The rate fills in when you pick a taxable item and follows the customer or property you choose. You can change
    any line's rate by hand.
  - Invoices made from a work order keep each line's rate.
  - The invoice adds up every line's tax and rounds once, then shows it as its own row before the total. The PDF
    shows a Tax column, and the customer portal shows the tax too.
  - With a discount, tax is charged on what the customer actually pays: the discount is spread across the lines in
    proportion.
- **Bigcapital:** turn on **Sales Tax** in Bigcapital's preferences as well. Crewdesk makes a Bigcapital tax rate for
  each rate it uses (e.g. "Sales tax 8.625%") and puts it on each taxed line, so the tax posts to Bigcapital's Tax
  Payable account.
  - Bigcapital taxes lines before an invoice discount, so if a taxed invoice has a discount, a small adjustment keeps
    both totals the same to the cent.
  - If Sales Tax isn't on in Bigcapital, the invoice's books status says so; post it again once it's on.
- **Sales tax report** (**Billing → Sales tax report**): invoices sent in the dates you pick, by month or quarter.
  - Columns: invoices, sales after discounts, taxable, untaxed, untaxed sales to tax-exempt customers, and the tax,
    with the tax by rate under each period.
  - Drafts and void invoices stay out.
  - **Print** it or **Export CSV** for your filing.

### Estimates

Billing → **Estimates** (or **New → Estimate**, or **New estimate** on a customer's page), laid out like Homeworks':

- **The list:** small tabs with counts (**Total**, **Pending**, **Accepted**, **Declined**, **Changes requested**, **Drafts**),
  a search (customer, title or number), and a **Next step** column (send it, waiting for the customer, make a work order
  or invoice). Estimates are numbered from 1000.
- **Making one:** a title, the customer and service address, the date, **Good until** (after that the customer can't
  accept it online), P.O. number, discount %, and when they asked for it. Then the lines, from the price list (priced
  for the lawn) or typed in, with **Qty**, **Rate**, **Visits** (a line's total is quantity × rate × visits, e.g. 6
  fertilizer rounds) and **Tax %**. **More** on a line:
  - **Optional (the customer chooses)**, and whether it **Starts ticked**; **Recommended** shows a badge.
  - A different service address for that line, **Our cost** (each) and **Hours per visit**: these stay in the office.
  - **Add package** adds a package's lines.
  - The totals show the subtotal, discount, tax and total, and (for the office only) the amount per visit, budgeted
    hours, our cost and the estimated profit and margin. Add **Terms**, **Notes for the customer** and **Internal
    notes**.
- **Send:** emails it with the PDF and a link. The customer sees it (no sign-in), ticks the options they want (the
  total updates), and **Accepts** by typing their name, **Asks for changes** (saying what), or **Declines**. You get a
  notification (Settings → Notifications → **Estimates**), and the estimate shows when it was seen. Signed-in
  customers also see their estimates in the portal.
- **Record their answer** if they tell you by phone; **Undo answer** puts a mistake back to pending.
- **After it's accepted:** **Make a work order** opens a new work order filled in with its title, address and the
  lines they chose (set the dates, crew and any repeat there); **Make an invoice** makes a draft invoice of those
  lines (multi-visit lines with the visits as the quantity). Both are linked from the estimate. To change an accepted
  or declined estimate, **Copy** it to a new draft.
- On the Customers list, the **Estimates** filter (pending, accepted, declined, changes requested, or none) and the
  **Open estimates** column (what pending ones come to).

#### Deposits on estimates

Deposits are **off** until an admin sets them in **Settings → Customers & billing → Deposits on estimates**.

- **Who and how much:** require a deposit from **new customers** (no invoices sent to them yet) or **every customer**.
  Set it as a $ amount or a % of the total they accept, and optionally only on estimates of at least a set total.
- **Per estimate:** on the estimate form, **Deposit to accept** is the company default, **No deposit**, or **Its own
  deposit** ($ or %). The form shows what it comes to at the current total.
- **Paying it:** on the estimate link, the customer sees the deposit with the total; it follows the options they
  tick. **Accept and pay deposit** asks for their name, then the card or bank form. The estimate is accepted once the
  deposit goes through (a bank payment that's still clearing counts). You get a notification that it was accepted
  with the deposit.
- **Where the money goes:** the deposit becomes a **prepayment** on the customer's account (PP-…), booked as income
  when received like any prepayment. It's used on their invoices as they're sent (only that property's invoices when
  the estimate has a service address).
- **The Deposit box** on the estimate shows the rule, the amount, and whether it's paid, clearing or still due.
- **Accepted by phone?** **Email a deposit link** sends the customer a prepay link for the deposit.
- **No online payments set up:** customers can still accept. Their notification tells you to collect the deposit
  yourself (add a check or cash prepayment on their page).

### Templates

**Resources → Templates** (Customers & billing managers) holds the emails and texts Crewdesk sends. The first two
tabs, **Email Templates** and **Sent / History**, are laid out like Homeworks, with the same kind of drag-and-drop
template builder. **Text Templates** and **Defaults** follow.

- **Email Templates:** the **Templates List** is on top; each template has a pencil (edit), a trash can (delete)
  and a copy icon. Clicking a name opens it too. Underneath are **Template Name**, **Subject** (with **Insert
  Tags** for the customer's name and the like) and the builder, then **Create Template** or **Update Template**
  (and **Cancel** while you're changing one).
- **Search templates** (top right of the list) narrows the list as you type.
- **Used by** on a template's line means it's already going out: hover over it to see which automations and
  sequences send it, and whether it's the template for every invoice, estimate or receipt (**Defaults**). When
  you **Update** a template that's in use, Crewdesk names what will change and asks first.
- **The builder** has a dark bar on top (**Actions**, **Show structure**, **Help**), three tabs on the left and
  the email on the right:
  - **Content:** the blocks: Title, Paragraph, List, Image, Button, Table, Divider, Spacer, Social, HTML, Video,
    Icons, Menu and Text. Drag one onto the email (a blue **Drop it here** line shows where it lands), or just
    click it to add it under the block you've picked.
  - **Rows:** layouts of one to six columns. Drag one onto the email or click it. Blocks go inside a row's columns.
    Switch the list from **Empty** to **Saved rows** for the rows you've kept (see **Saved rows** below).
  - **Settings:** how wide the email is, left or centered, the background colors, the default font, the link
    color, the **preheader** (the short line inboxes show after the subject) and who the template is for
    (customers or your team).
  - **Click a block** to change it: its **Content properties** open on the left (font, size, colors, alignment,
    padding, links, hide on desktop or phone). The small bar above it deletes or copies it; the round handle
    drags it somewhere else. **Click a row** (or its **Row** tab) for its backgrounds, border, columns and whether
    its columns stack on a phone.
  - **Words are typed right on the email.** While you type, a bar offers bold, italic, underline, strikethrough,
    text and highlight colors, special characters, emoji, links and **Merge tags** (the fill-ins).
  - **Images:** **Add image**, **Browse**, or drop a picture on the block (JPEG, PNG or GIF, up to 5 MB). It's
    stored in Crewdesk.
  - The desktop and phone buttons at the top left of the email show it at each width; undo and redo are at the
    bottom right.
  - **Actions → Preview** shows the finished email at desktop, tablet or phone width, with example values or
    filled in for a customer you pick. **Actions → Send test** emails it to any address (yours by default), with
    the fill-ins shown as example values.
- **Saved rows** are rows you design once and use in every template, like a header or a footer.
  - **Save one:** click a row, then **Save this row to reuse** and give it a name. It's now in **Rows → Saved
    rows**; drag it onto any template, or click it to add it at the end.
  - **It's the same everywhere.** On the email a saved row is marked **Saved row: (name)** and can't be typed in
    there. Click it, then **Edit saved row**: it opens by itself, and **Save row** changes every template that
    uses it (the page says how many). **Unlink** makes it that one template's own row again.
  - **Deleting** a saved row (the × in the list) leaves it in each template as that template's own row.
- **My header** (**Rows → Saved rows → My header**) makes the saved row **Header**: your logo (or your company
  name, until a logo is added in **Settings → Company info**) on a background, over a line of your color. Crewdesk
  reads starting colors from your logo; change the **Background** and the **Line and buttons** color and the
  preview follows. The second color is also what new **Button** blocks start in. Open it again any time to
  change the colors everywhere at once.
- **Homeworks' header pictures:** templates brought in from Homeworks show Homeworks' own artwork on top, kept on
  Homeworks' servers, so it stops showing if Homeworks takes it down. While any template has one, a notice at the
  top of the page says how many. **Use my own header…** (admins) puts your **Header** in every one of them and
  takes those pictures out. Where a picture named what the email is about (like "Estimate Accepted"), a title
  says it instead. The wording of the emails isn't touched.
- **Tags (fill-ins)** are the same names Homeworks uses, e.g. `{{CUSTOMER_FIRST_NAME}}`, `{{INVOICE_BALANCE}}`,
  `{{ESTIMATE_LINK}}`, `{{EVENT_DATE}}`, `{{REVIEW_PAGE}}`. Tags about an invoice, estimate, work order or payment
  are filled in when the email is about one, and left empty otherwise. A link tag shows as words ("View and pay
  your invoice"), or put it in a **Button**'s Url. In a text, it's the address.
  - About the work: `{{EMPLOYEE_FIRST_NAME}}` and `{{EMPLOYEE_LAST_NAME}}` (whoever finished or skipped the visit,
    or the first person it's assigned to), `{{EVENT_NOTES}}` (the notes written when it was finished) and
    `{{PROPERTY_NOT_SERVICED_REASON}}` (why a visit was skipped).
  - `{{INVOICE_TAX}}` is the sales tax on the invoice. `{{UNSUBSCRIBE}}` is an unsubscribe link you can place
    yourself (one is added at the bottom either way).
- **What's added when it's sent:** your company name, address, phone and website underneath, and an
  **Unsubscribe** link on emails that aren't bills.
- **Templates from Homeworks** open as the same blocks they had there. **Import** (admins, top right) takes the
  Homeworks file Crewdesk made: each template comes in once, and a newer file brings a template up to date only
  if nobody has changed it in Crewdesk.
- **Templates written before the builder** open as blocks too, with your logo on top as those emails had. Until
  you save one from the builder it keeps going out exactly as before.
- **Crewdesk's own templates** (Invoice, Estimate and Payment receipt) keep their names and can't be deleted.
  Open one, then **Settings → Reset to Crewdesk's wording** puts it back.
- **Sent / History:** every invoice, estimate, receipt and template email, with a **Search**: Email ID, Subject,
  Content (**View** shows what was sent), Recipient, Status, Sent Time, Open Time, Open Count and Notes (the
  template used, or why it failed). Opens come from a tiny image in the email; some mail apps load it on their
  own, so treat opens as a hint.
- **Text Templates:** plain text (emoji are fine), with the list on the left and a preview that shows how many
  texts one send takes: 160 characters fit in one, or 70 once there's an emoji or special character.
- **Defaults:** which template goes out when you **Send** an invoice or estimate, and when a customer pays
  online; whether the PDF is attached; and your **review link** for `{{REVIEW_PAGE}}`. The text goes to customers
  whose invoices are set to go **by text**, once texting is connected (admins).

### Texting customers

Texts go from your **Talkroute number**, so customers keep texting the number they know. **Resources → Text** (and
the chat bubble at the top right, which shows how many conversations have something unread) is laid out like
Homeworks' Text page.

- **Connecting:** **Settings → Integrations → Texting (Talkroute)**. The owner pastes the **API key** from Talkroute
  (it starts with `tr_live_`) and presses **Find my numbers**; Crewdesk lists the Talkroute numbers that can text,
  and the owner picks the one customers text and presses **Connect**. Crewdesk then asks Talkroute to tell it about
  every new text, so texts arrive as they're sent. **Send a test text to my phone** checks it end to end.
  - Reading texts works with any Talkroute API access. **Sending** through the API needs Talkroute's **bulk
    texting plan**; without it a send fails with a message saying so.
  - A number Talkroute lists as *not registered for business texting* can connect, but carriers may block its texts
    until it's registered with Talkroute (10DLC).
  - Texts sent from Talkroute's own app or website show up in the Crewdesk conversation too.
- **Who's told when a text comes in:** on the same card, tick the people. Each one gets a notification on their
  phone (and in their Crewdesk inbox) for every incoming text; tapping it opens the conversation. The people ticked
  can read and answer texts on Resources → Text and in the phone app even if they aren't Customers & billing
  managers (they see the customer's name, not the customer's page). With nobody ticked, the Customers & billing
  managers are told. Each person can still tune it under **Notification settings → Text messages**.
- **Text Messages** (the first tab): every conversation, newest first, with the open one beside the list.
  - **All / Unread / Open / Done** narrows the list; the search box finds a name, a number or words in a text.
  - Click a conversation to read it. Type in the box and press **Send**. **Insert Customer / Company Info** adds a
    tag (filled in for that customer), **Insert Template** drops in a text template, and the line underneath counts
    words and characters and says when a long text will go as more than one.
  - **Mark unread** puts it back under Unread for later. **Open / Done** marks a conversation dealt with; a new
    reply opens it again. **Delete Messages** (admins) removes the conversation from Crewdesk (it stays in
    Talkroute).
  - A text from a number that isn't on a customer shows the number; **File the conversation under a customer…**
    attaches it. A text from someone on your team is filed under their name.
  - The round **+** starts a new conversation with a customer, an employee or a number you type.
- **Send Text Messages** (the second tab): pick a **Template** or write the message, then pick who gets it in the
  box on the right: **Customers**, **Groups**, **Employees**, **Crews** or a **Number**. Add as many as you like.
  One person's text goes right away. More than one are lined up and go out a few a minute (carriers slow or block a
  burst); **Messages History** shows how many have gone, any that didn't, and who was left out and why (no mobile
  number, replied STOP, a sample customer, or the same number twice). **Stop** drops what hasn't gone yet.
  - **Groups:** on the Groups tab, type a name under **Add Customer Group** and press **Add Group**. The person
    icon opens its members (add customers or employees with **+**, take them out with **×**), the pencil renames
    it, and the red × deletes it.
- **Text Message Templates** opens Resources → Templates, where text templates are kept.
- **Error Log:** texts that didn't go, with the date, what Talkroute said, and the number.
- **From the Customers page:** **Send ▾ → Text N customers…** texts the customers ticked (or everyone the list
  matches), each with their own tags filled in. Until texting is connected it offers their phone numbers to copy.
- **On a customer's page:** **Communication** shows their texts as a conversation with a box to write one.
- **Who can be texted:** their phone (or other phone) on file. A customer who replies **STOP** isn't texted again
  until they reply **START**; their page and the conversation say so.
- **Pictures:** a picture a customer texts shows in the conversation (click it to see it full size) and is also
  put with the customer's **photos and documents**, captioned "Texted to us" with the date. To text one back,
  press **Picture** under the message box and pick a JPG, PNG or GIF; whatever is typed in the box goes with it.
  Photos are shrunk before they go, because carriers turn away large ones.
- **Notes:** switch the box under a conversation from **Text** to **Note** to write something for the office
  ("called her back, she'll decide Friday"). A note sits in the conversation in yellow and is never sent.
- **Whose conversation it is:** the box at the top of a conversation says **Everyone's** or a person's name. Give
  it to one person and only they are told about its texts from then on (they get a notification saying it's
  theirs). **Mine** in the list shows the ones given to you. Set it back to Everyone's to hand it back.
- **Create ▾** on a conversation: **To-do from their last text** makes a to-do for you, due today, with what they
  said and the customer on it. **Work order…** and **Estimate…** open a new one for that customer with what they
  said already in the notes.
- **Quick replies:** answers you send often. Type one in the box, open **Quick replies ▾** and press **Save
  what's in the box as a quick reply**; after that it's a click away for everyone. The × deletes one.
- **Send later:** press **Send later…**, pick the date and time, then **Schedule**. The text waits at the bottom
  of the conversation ("Goes Nov 27, 8:00 AM") with **Take it back** beside it until it goes. Sends to several
  people can wait the same way; **Take back** is under Messages History.
- **Quiet hours:** each person can tick **Quiet hours** at the top of Resources → Text and set a start and end
  (9:00 PM to 7:00 AM, say). During them, texts still land in their Crewdesk inbox but their phone doesn't buzz.
  Admins can set them for each person under Settings → Integrations.
- **After-hours reply** (Settings → Integrations): tick it, write the reply, and set the hours the office is open
  each day. A text that arrives while the office is closed gets that reply by itself, once per conversation every
  8 hours, and never to someone who replied STOP or to your own team.
- **Missed-call text** (Settings → Integrations): tick it and write the text. When a call to your number is missed
  or goes to voicemail, the caller is texted (at most once per number every 8 hours).
- **Calls & voicemails** on a customer's page (Communication): calls to and from their number on your Talkroute
  line, missed ones marked, and each voicemail with what was said (when Talkroute wrote it out) and **Play the
  recording**.
- **Past conversations** (Settings → Integrations): **Bring in from Talkroute** copies the last 30 days, 90 days
  or year of conversations into Crewdesk as history. Nobody is notified, nothing is marked unread, and ones that
  went quiet over a month ago come in marked Done.
- **Talkroute contacts** (Settings → Integrations): **Copy customers to Talkroute** puts every customer with a
  phone number into Talkroute's contacts, so their names show in Talkroute's apps. Ones already copied are left
  alone (a later name change in Crewdesk isn't pushed), and new customers are copied overnight from then on.

### Automations

**Resources → Automations** sends emails and texts, adds or removes tags, and makes to-dos on its own when something
happens. It's laid out and worded like Homeworks' Automations page, tab for tab: **Automations**, **Sequence
Automations**, **Sequence History**, **Review Sequence**, **Text Message Templates**, **Email Templates** (these two
open Resources → Templates) and **Automation History**. A Homeworks "Visit" is a Crewdesk work order. Admins in
Customers & billing set them up; managers can see them and work Review Sequence.

- **Automations tab:** the five lists at the top (Trigger Condition, Run Time, Action, Sub Action, Status) and
  **Filter** narrow the table. The table has Homeworks' columns: Id, On - Off, Automation Name, Trigger Condition,
  Run Time, Action, Sub Action, Review, Notes, Tags and Actions (the pencil edits, the trash deletes after
  "Are you sure you want to delete this Automation?"). The **On / Off** pill turns one on or off, and the
  **Review** pill sets Review Before Execution. **11/11 Columns** picks which columns show.
- **New Automation:** Automation Name, **Trigger Condition** (Homeworks' list, in its order), **Run Time**
  (Instantly; 1, 2 or 3 Days Before The Event Happens; 2 or 15 Minutes, or 1, 3, 5, 7, 15 or 30 Days After Trigger
  Condition), **Action** (Text or Email Company Owner, Customer or Employee; Push Notification Reminder; Add a Tag;
  Remove a Tag) with its Text Template, Email Template, Employee or Tags, **Sub Action** (Nothing, Run Another
  Automation with Next Automation and When To Run The Next Automation, or Stop Automation, which turns it off after
  it runs once), Review Before Execution, Notes / Description and Tags (words to find it by). A new automation is
  **on** as soon as it's added, as in Homeworks. "Days Before" run times go with the "Before…" triggers (they run at
  9 AM that many days ahead); "Run at a Certain Time" asks for a date and time instead.
- **Push Notification Reminder** goes to whoever the work order or to-do is given to (and the work order's crew);
  to the owner when it's no one's.
- **Sequence Automations:** a card per sequence with its title, description and Id, and its On / Off pill. Click
  the title to read what it does ("This trigger sequence will kickstart when … wait for … then …"), with **Delete**
  and **Edit**. **New Automation Sequence** opens the editor:
  - **IF Trigger**, then **AND Condition** (all of these must be true: customer has or doesn't have a tag, has no
    card on file, has no recurring service, is inactive; estimate is a draft or has a service; to-do has a
    category; invoice is paid or partly paid) and **OR Condition** (starts another group; either group is enough).
  - **Action** adds a step with its **Waiting Period** (Instantly, or After so many Days, Hrs and Min, counted from
    the trigger), the Action and its template, employee, tag or to-do title. A sequence can also **Create & assign
    a to-do**, due 8 AM the day after its waiting period.
  - **ELSE Trigger** adds another block for a different trigger; the first block whose trigger happened and whose
    conditions are true runs.
  - **Stop When** (and **OR Stop Condition**) ends it for that customer; **Stop Action** does something then, after
    its own waiting period.
  - **Review Before Execution**, and **protect the Sequence with a password**: after that, changing or deleting it
    asks for the password (the owner is never asked, and can take the password off).
- **Texts** only go out **9 AM to 6 PM**; one due at night waits until 9 AM.
- **Once each, from when it's on:** each runs once per thing that happened (an estimate, an invoice, a work
  order, a tag change…), and only for things that happen after it's turned on. A repeating work order counts once.
  Turning one off stops what's still waiting.
- **Review Sequence:** with Review Before Execution on, each action waits here. **View message** shows it filled
  in for that customer; **Approve** sends it and **Reject** skips it (each asks "Do you really want to…?"). The tab
  and My Day show how many are waiting.
- **Automation History** lists what automations did: ID, Date, Trigger Condition, Action and Status Message
  ("Message sent to Amy Aster at … successfully"), green when it went and red when it was skipped or failed, a page
  at a time. **Sequence History** lists every action a sequence queued, with when it was Added, Scheduled and
  Executed (PENDING until it runs); click those three headings to sort.
- **For one customer:** their page's **Automations** tab has the same filters and table, where On / Off is for that
  customer only (one that's off for everyone has to be turned on in Resources → Automations first). Sequences are
  listed under it, then what has run for them, with **Stop** for something still waiting.
- **Leaves things alone:** emails skip customers who unsubscribed, texts skip ones who replied STOP, sample
  customers are only used in the test company, and an action about a voided invoice, a work order that's no longer
  coming up or an estimate already answered is skipped.
- **Bringing in Homeworks:** **Import from Homeworks** (admins) takes the one Homeworks file Crewdesk made:
  templates first, then every automation and sequence, all **turned off**, each keeping its Homeworks Id, tags and
  notes, and listed in Homeworks' order. Turn each one on with its own On / Off pill when you're ready. An
  automation Homeworks had no template picked for needs one picked first; ones about meetings, reviews, work
  requests or tips can't run because Crewdesk doesn't have those yet (a sequence with only some such parts still
  runs the rest). When a switch won't turn on, the reason shows under that automation's name. Importing the file
  again changes nothing already here.
- Automations check every few minutes, so "Instantly" means within about five minutes.

### Documents (letters, contracts, proposals)

**Resources → Documents** (Customers & billing managers) is where you write a letter, contract or proposal once
and email or print it for the customers you pick, each one filled in with that customer's own details. It's laid
out like Homeworks' Documents: the form on the left, the list on the right, and two tabs, **Documents** and
**Document Templates**. (**Team → Documents** is a different page: employees' paperwork and signatures.)

- **Document Templates** are the starting points (Thank You, Price Increase, Contract…). Give one a **Name** and
  write the **Content**, then **Create Template**. The pencil changes one; the trash deletes it. Admins can bring
  Homeworks' document templates in with **Import from Homeworks** under the list (choose the Homeworks documents
  file Crewdesk made; importing again adds nothing twice). A newer file brings a template up to date only if
  nobody has changed it in Crewdesk; ones you've changed are left as they are.
- **Documents:** pick a **Template** (it fills in the name and content; you're asked first if you'd already
  written something), change what you like, and **Create Document**. Or write one from scratch.
- **Content box:** **+** adds a heading, list, quote or line; **</>** shows the HTML; **¶** sets normal text or a
  heading; then align, **B**old, *I*talic, underline, strikethrough and link. **Insert Customer / Company Info**
  puts in a fill-in such as `{{CUSTOMER_NAME}}`, `{{CUSTOMER_ACCOUNT_BALANCE}}`, `{{COMPANY_PHONE}}` or `{{TODAY}}`
  (the same names Homeworks uses). The word count is underneath. If you type a `{{NAME}}` that isn't a fill-in,
  Crewdesk tells you when you save; it would come out blank.
- **Header - Click to show** shows the letterhead every letter is printed on: your company name, address, phone,
  email and website on the left and your logo on the right (from Settings → Company Info).
- **Documents List:** search by name. Each document has **Send Email**, **Print**, **History**, **Edit** and
  **Delete**.
- **Send Email:** pick customers from **Select Customers** (search by name or email; click one to add it, × to
  take it off; up to 200 at a time). With **Use The Selected Document As The Email Content**, the document is the
  email, in your email letterhead with an Unsubscribe link; tick **Attach PDF of document to email** to add the
  printed letter too. Or pick one of your **email templates** as the cover note, and the document goes as a PDF
  attachment. Each customer gets their own email. Customers with no email address, ones who unsubscribed and
  sample customers can't be picked.
- **Print:** pick customers, then **Print**: one PDF opens with a letter for each customer, on your letterhead,
  addressed to their billing address (or their property when there's no billing address). It's laid out for a
  standard #10 double-window envelope folded in thirds, like your invoices. Printed links show the web address.
- **Preview** (in both pop-ups, next to Send Email or Print) shows the document as one of the picked customers
  will get it, before anything is sent: the email with its subject, or the letter on its page. Choose whose with
  **Preview for**. **Open the exact page as a PDF** shows the real printed page; it doesn't count as printed.
- **To a whole list:** on the **Customers** page, filter the list or tick customers, then **Send ▾ → Document:
  email or print letters…**. It shows how many an email reaches and who's skipped and why, with a preview for the
  first customer. **Email N customers** sends it; **Print letters for the ones email can't reach** makes letters
  for customers with no email address or who unsubscribed, so everyone hears from you. Up to 5,000 customers per
  email and 2,000 letters per PDF.
- **How emails go out:** one at a time in the background, so you can keep working. **See how it's going** (and
  Customers → **Bulk emails**) shows who it was sent to, who was skipped and anything that didn't go, with **Stop
  sending** while it's still going. Each email is also on the customer's own page and in Templates → Sent / History.
- **History** shows who created and changed a document and each time it was emailed (how many were sent, failed
  or skipped, with a link to **who got it**) or printed.

Homeworks' **Send By Regular Mail** (its paid stamps service) isn't in Crewdesk: print the letters and mail them.

### Visit forms

**Resources → Visit Forms** (Customers & billing managers) is laid out like Homeworks'. A visit form is something
the crew fills in on a work order: a service checklist, a quality check, notes on the lawn or the weather, a
sign-off.

- **Forms** and **Submitted** are the two tabs on top: the forms you've made, and everything the crew has
  submitted (see **The Submitted tab** below).
- **The list** shows each form's name, when it was last changed, how many work orders it's on (and on how many
  it's been submitted), and whether it's **Auto Attached** (Yes, No, or **By service**). Small labels show a form
  that's **Needed to complete** a work order, one that **Emails the customer**, and one that **Flags answers**.
  The pencil opens it; the trash can deletes it.
- **New Form** opens the builder:
  - **Form name** on top (two forms can't share a name).
  - A form is made of **sections**. Give a section a name, then use the **Add:** row under it: **Short Text
    Field** (a one-line answer), **Long Text Field** (notes), **CheckBox** (a list to tick; **Add New Checkbox**
    adds another), **DropDown** (pick one; **Add New Option** adds another), **Yes / No**, **Number**, **Date**,
    **Photo** (the crew takes or chooses pictures, up to 12 a question; they're also kept with the work order's
    photos) and **Signature** (a signature box of its own, so one form can have, say, a technician's and a
    customer's). Type the question in each box. The last five are Crewdesk's; Homeworks has the first four.
  - **Required** under a question means the form can't be submitted until it's answered. Required questions show
    a red star.
  - **The flag (⚑)** beside a checkbox, a dropdown option or Yes / No sets what picking that answer does for the
    office: **add a tag** (to the customer and the work order) and/or **make a to-do for the office** (it goes to
    whoever made the work order, named after the question and the answer, with the customer on it). For example:
    "Pest damage seen? Yes" adds the tag "Pest follow-up" and makes a to-do. Each answer does this once.
  - The small arrows move a question (or a section) up or down; the trash can or × removes it.
  - **Accept Signature with this form** adds a signature box at the end; change its label if you like
    (for example "Customer signature") and tick **Required** if the form can't go in without it.
  - **Add New Section** starts another section.
  - **Automatically attach to new work orders** puts the form on every new work order (it can still be taken off
    any one of them).
  - **Or attach to new work orders that include one of these services:** pick price-list services, and the form
    goes only on new work orders with one of them (a grub treatment checklist on grub treatments, not on mowing).
    On the work order form it's picked as soon as the service is added to a line.
  - **Must be submitted before the work order can be marked Completed:** the crew gets "Submit the form before
    marking it Completed" until it's in. The work order shows **Needed before Completed** beside the form.
  - **Email the customer a copy when the work order is completed** is off unless you tick it. With it on, the
    customer gets the submitted form as a PDF when the work order is marked Completed (or right away, if it's
    submitted after that). It's sent once, never to sample customers, and only if the customer has an email
    address that's working. The wording is the **Visit form copy (Crewdesk)** email under Resources → Templates.
    With it off, nothing is sent unless someone presses **Email to customer** on a submitted form.
  - **Preview** shows the form as the crew will see it (try it; nothing is saved) and can **Print** a blank copy.
  - **Save Form** saves it. Leftover empty questions and options are dropped. HTML isn't allowed in a form.
  - On a form you've saved, **Duplicate Form** makes "Copy - (name)" to start a similar one from.
- **Putting forms on a work order:** the work order form has a **Visit Forms** box. Click it, search, and pick as
  many as you want (the list stays open). Forms set to attach automatically are already picked on a new work
  order. A repeating series gets the forms on every work order in it.
- **Filling one in:** on the work order, **Visit forms** lists each form with a dotted circle (not submitted) or a
  green check (submitted). Click one, answer it, sign in the box with a mouse or a finger (**Clear** starts the
  signature over) and press **Submit**. Afterwards it shows who submitted it and when, and the button becomes
  **Update** once something is changed. The crew on the work order and managers can fill forms in. Only
  questions marked **Required** have to be answered ("Still needed: …" lists what's missing). **Print** gives the
  form, with its answers, on a page of its own, and **PDF** opens it as a PDF with your company on top.
- **Email to customer** (managers, on a submitted form) sends the customer the PDF now, whether or not the form
  emails copies by itself. The form then says who it went to and when; sending again asks first.
- **History** at the bottom of a submitted form lists who submitted it, each later change (the question, what it
  said before and after) and each email to the customer.
- **Once the work order is on an invoice its forms are locked:** they can be read, printed and emailed but not
  changed. Void the invoice to change one.
- **On the phone:** the crew sees **Visit forms** on each of their work orders (Tasks tab); tapping one opens it
  to fill in, take photos, sign with a finger, and **Submit**. A form that's needed before Completed says so.
  (New kinds of question reach the phones with the next app update; until then, fill those forms in on the web.)
- **On the customer's page:** a **Visit forms** box lists the forms submitted on that customer's work orders,
  newest first; click one to read it, print it or email it. **See all** opens the Submitted tab for that customer.
- **The Submitted tab** lists every submitted form with when, the work order, the customer, who submitted it and
  a short read of the answers. Narrow it by **Form**, **From** / **To** dates, **Submitted by**, or **Search**
  (customer, address, work order or a word in an answer). The eye opens the form. **Export** downloads what's
  listed as a spreadsheet, with a column for each question.
- **Taking a form off a work order** (edit the work order and remove it from the box) removes it only if it
  hasn't been submitted: "Any Unfilled forms will be removed from visit event. Saved form will remain."
- **Changing a form** changes the copies on work orders that haven't been submitted yet. Submitted ones stay
  exactly as they were answered, even if the form is later changed or deleted.
- **Deleting a form** takes it off the work orders where it hasn't been submitted; submitted copies stay on
  their work orders.

### Online payments and the customer portal

Customers pay invoices by **card or US bank account** through Stripe. Card and bank details are typed into Stripe's own
form and go straight to Stripe; Crewdesk never sees or keeps them.

- **Setting up (owner):** Settings → Integrations → **Online payments (Stripe)**. In Stripe, open **Developers → API
  keys**, copy the **Publishable key** (pk_…) and the **Secret key** (sk_…, click Reveal), paste both and click
  **Connect**. Crewdesk checks them with Stripe, keeps the secret key encrypted, and sets up the link Stripe uses to
  report payments. The test company only takes **test keys** (pk_test_ / sk_test_), so no real money moves there; use
  your **live keys** in the real company. **Disconnect** turns online payments off.
- **Pay link:** once Stripe is connected, every emailed invoice has a **Pay online** button, and paper invoices say
  "Or pay online" with the portal address on the stub. The link opens that one invoice with no sign-in and works for
  **30 days** after the invoice was last sent (sending it again restarts the 30 days). On the invoice page,
  **Copy pay link** gives you the link to text or read to a customer.
- **Customer portal** (management.prospray.net/portal): customers type the email address on their account (or the
  email of a contact marked "copy on invoices"), get a 6-digit code or a sign-in link by email, and see their balance,
  invoices to pay, paid invoices and PDFs, and past payments. They can pay any open invoice and fix their phone number
  and billing address (changes go to Bigcapital too). There's no password. An address that isn't on an account gets
  no email, so the portal never reveals who your customers are.
- **What happens when they pay:** a card payment marks the invoice **Paid** right away and emails the customer a
  receipt. A bank payment shows as **clearing** for about 4 business days, then **Paid** (with a receipt); if the bank
  returns it, it shows **failed** and the invoice still owes the amount. Stripe reports each payment to Crewdesk, and
  Crewdesk also checks clearing bank payments with Stripe every hour in case a report goes missing. Online payments go
  to Bigcapital like any other payment (to 1030 Card Processor Clearing).
- **Cards and bank accounts on file:** customers can keep a card or bank account with Stripe for later:
  - In the portal, **Payment methods → Add a card or bank account**, or tick **Save this card or bank account for
    next time** when paying an invoice. They can pick the default and remove one there.
  - On the customer's page, **Cards & bank accounts on file → Add a card** saves a card they read out to you over
    the phone. Bank accounts need the customer's own authorization, so they add those in the portal.
  - The details stay at Stripe; Crewdesk shows only the kind, last 4 digits and expiry (e.g. Visa ·· 4242,
    expires 04/28). Removing one removes it from Stripe too.
  - **Charge** on an invoice page charges what's still owed to a saved card or bank account (the default, or pick
    another). A card is paid at once; a bank payment clears in about 4 business days. A decline says why (e.g. not
    enough funds, or the card's bank wants the customer to approve it, in which case send them the invoice).
  - **Autopay** (the tick box on the customer's page, or **Pay automatically** in the portal): when an invoice is
    sent, its balance is charged to the default card or bank account right after, and the customer gets the
    invoice and a receipt. If it doesn't go through, the invoice says why and stays owed (charge it again once
    fixed). Autopay turns off by itself if the last saved method is removed.
  - On the Customers list, the **Payment method on file** filter (card, bank account or none) and **Autopay**
    filter, and the **Card / bank on file** and **Autopay** columns.
- **Refunds:** on the invoice page, **Refund** (admins in Customers & billing) next to a card or bank payment sends
  all or part of it back through Stripe; choose the amount and reason and add a note for your records. Refunds made
  in Stripe's own dashboard come into Crewdesk too, usually within seconds (and an hourly check catches any that
  didn't). Either way, the payment shows what was refunded, when, why and whether it was done in Crewdesk or in
  Stripe, and the customer gets an email. Tick **Write it off** when refunding from Crewdesk (a goodwill refund) and a
  credit for the refunded amount goes on the invoice, so it stays paid. Otherwise the invoice owes the refunded amount
  again (**Partly paid** or **Unpaid**), for example when a customer paid with the wrong card; after a full refund you
  can **Void** the invoice if it won't be collected. A refund made in Stripe's dashboard always comes in as owed
  again; to write it off, **Add credit** on the invoice. In Bigcapital, the payment is replaced
  by one for what's left, or taken out if it was fully refunded. Bank refunds show **on its way** until they finish
  (up to 5 business days); a refund that fails puts the payment back as paid. A bank payment still clearing can't
  be refunded until it clears. Stripe keeps its original fee on a refund. Cash and check payments are voided, not
  refunded.
- **View as customer:** the button on a customer's page opens the portal exactly as they see it, in a new tab, for an
  hour. It's read-only: paying and changing details are turned off.
- **Fees:** Stripe charges about 2.9% + 30¢ per card payment and 0.8% (up to $5) per bank payment; the fee shows on
  each payment. Customers pay the invoice amount; there's no surcharge.

### Test company

A separate company, named after yours with "(Test)", for trying things out without touching real customers or books.

- **Getting in:** owners, admins, managers and anyone with Customers & billing access click their initials at the top
  right, then **Open … (Test)**, on any page (also on the Customers page's **⋯** menu, and Settings → Company Info). No separate password: you switch in as yourself. While
  you're in it, a yellow **TEST** badge sits next to the company's logo or name in the top bar (with a yellow line under
  the bar); click it, or open your initials menu, for **Back to the real company**.
- **What's in it:** the sample customers are loaded the first time anyone opens it. Nothing else is copied: it has
  no employees, payroll or settings of its own beyond what you add. Its sign-ins never get email.
- **Test payments:** connect Stripe in the test company with your Stripe **test keys** (Stripe → turn on Test mode →
  Developers → API keys). Then send a sample invoice and pay it from **Copy pay link**, or put your own email on a
  sample customer and sign in to the portal as them. Use card **4242 4242 4242 4242** (any future date, any CVC and
  ZIP), or **Test Institution** for a bank account. A yellow note on the pay page reminds everyone it's test mode.
- **Test books:** connect it to a test organization in Bigcapital (Settings → Integrations, with that
  organization's own API key), then click **Set up test books** to give it the same chart of accounts and
  preferences as your real books. This button only exists in the test company and is refused anywhere else.
- **Starting over:** the owner can **Delete test company** (Settings → Company Info); everything in it goes, and
  the real company isn't affected. Creating it again starts fresh.

## Work orders

A **work order** is a scheduled job at a customer's property, like Homeworks' visits: "Round 3: fertilizer & weed
control", "Core aeration". (Jobs on your own trucks and equipment are **repair orders**, under Fleet.) Work orders
are numbered **WO-1001**, **WO-1002** and so on. Open them from **Schedule → Work orders**, the **Calendar**,
**+ New → Work order**, or the **Work orders** box on a customer's or property's page.

- **Making one** (Customers & billing managers), laid out like Homeworks' visit form:
  - **Title or description**, the **customer** and their **property** (required), an optional **location** and a
    **color**.
  - **Billing:** **Invoice services** or **Don't invoice** (a free call-back, an estimate visit).
  - **Line items:** pick a service from the price list (it's priced for the property's lawn size, like invoices; the box under the description prices it from the front or back lawn only, or a size you type)
    or type a custom item; set the quantity, **budgeted hours** and rate. The total is what it bills.
  - **Scheduling:** **Single work order**, a **Repeating series** (every N days, weeks, months or years until a
    date, up to three years), or **Add to the waitlist** (no date yet). A series can skip an **off-season** (tap
    the months with no work, such as Dec, Jan, Feb). The form shows how many work orders it will make and their
    total. Also **More than one day**, **Set a time** and **Budgeted hours** (blank: the line items' hours).
  - **Line items** can also come from a **package** (**Add package…** next to **Add line**).
  - **Crew:** pick a **crew** to fill in its people, then tick or untick anyone (or skip the crew and just tick
    people). They get a notification, and a reminder the morning it's scheduled.
  - **Tags:** from the company's tag list (the same tags as customers and properties, kept in Settings →
    Customers), such as Callback, Warranty or Estimate.
  - **Notes for the crew:** gate, where to start, what to watch for.
- **Who sees what:** Customers & billing managers see, schedule and invoice every work order. Everyone else sees
  the ones they're on, without prices.
- **The crew's steps** (website or phone): **Arrived (on site)**, then **Completed** (with optional notes), or
  **Skip** with a reason. The time from arriving to finishing is kept as **time on site**. **Undo** reopens it
  (not once it's on an invoice).
- **Photos & documents** (like Homeworks'): on a work order, drop files on the box or **Add** them: photos (JPG,
  PNG, HEIC, WebP, GIF), PDFs and short videos (MP4, MOV), up to 25 MB each and 40 per work order. Big photos are
  shrunk before they're sent. Click one to see it full size (← → to page through), add a **caption** (Before,
  After, problem spot…), **Download** or **Remove** it. The crew adds them from the phone (**Add photo**: take one or
  choose several). The crew on the work order and managers add them; whoever added one, or a manager, removes it.
  Everyone who can see the work order sees them. They're stored encrypted like other uploads.
- **Visit forms** (like Homeworks'): checklists and sign-offs the crew fills in on the work order. Pick them in the
  **Visit Forms** box when making or editing a work order (forms tied to a service are picked when that service is
  added); they're listed on the work order with whether each has been submitted. A form can be set so the work
  order can't be marked Completed until it's submitted. See **Visit forms** (Resources → Visit Forms).
- **The Work orders page:** **Show** Coming up, Waitlist, **Ready to invoice**, Completed, Skipped or All;
  filter by **Person**, **Crew**, **Tag** and **Search** (WO number, title or notes). Overdue open ones are marked;
  📎 shows how many photos and documents one has, and its tags show under the title.
- **Invoicing:** on a work order, **Create invoice** makes a draft invoice with its line items. Or choose
  **Show → Ready to invoice**, pick several and **Create invoices**: one draft per customer and property, each line
  dated. Review and send them from Invoices as usual. Deleting a draft (or voiding an invoice) puts the work
  orders back in Ready to invoice.
- **Changing one:** **Edit** on the work order (a repeating one asks: just this one, or this and the later ones
  that aren't done; moving the date moves them all by as many days). Put it **On the waitlist** to take its date
  off. **Delete** (one, or this and later); work orders on an invoice stay.
- **On the calendar** they show first, with their price (managers), the day's **$ total** and the range's total.
  The **Invoice**, **On site**, **Tracked time**, **Crew** and **Product/Service** filters and the **Revenue** sorts work on them.
  The waitlist (hourglass) lists work orders with no date: drag one onto a day. **+** on a day asks **Work order**
  or **To-do**.

## Waiting list

**Schedule → Waiting list** (Customers & billing managers) holds every work order that needs doing but has no
date yet: one-time services, callbacks, accepted estimates and anything put **On the waitlist**. It's one page:
the views and filters on top, then the map, the week's workload, and the list. Select work orders on the map or
the list, then **Edit work orders** to schedule them.

- **The window on each work order** (on the work order form, under **Window, priority and appointment time**):
  - **Eligible from:** its release date. Until then it's hidden (choose **Include not released yet** to see them).
  - **Due by:** when its window closes. It's flagged **Closing** 7 days before, and **Missed** after.
  - **Minimum days since the last service** (e.g. 21 between rounds): the list shows the first date it may be done.
    Scheduling it sooner asks for a reason, which is kept on the work order (**Scheduled early**).
  - **Priority** (low, normal or high) and an **appointment window** ("after 1 pm", or 9 am to 12 pm).
- **Badges** (the **Badges** button explains each): **Missed**, **Closing**, **Too early**, **Needs card**,
  **High priority**, **Dog** (from the property's pets), **Text ahead**, **Email ahead** and **Call ahead**.
- **Filters** show as chips (✕ removes one): service, **tag**, **Map Code**, city, ZIP, priority, badge, preferred
  crew (or none), **within X miles of a property**, due by and eligible by, plus the search box. Several of one kind
  match any of them (Round 3 or Round 4). They apply to the map and the list.
  - **Tag:** search the list and tick one or more tags (the number is how many on the list have it). It matches
    tags on the work order, the customer or the property.
  - **Map Code:** **is** for exact codes, or **starts with** (80 matches 801 and 802). Type several with commas
    between them, e.g. **801, 802, 805**.
- **Views:** ready-made ones (Closing or missed, High priority, Needs a card, Back from the schedule, Coming up)
  and your own: **Save view** keeps the filters, columns and sort, just for you or **shared with everyone**.
- **The map:** a pin per work order, colored by service, with a **red ring** when it's closing or missed. Nearby pins
  group into numbered circles (click one to zoom in). Click pins to select them, or **Group Selection** and drag a
  box around a neighborhood: every pin inside is ticked. The box stays on the map so you can adjust it: drag a
  **corner** or an **edge** to resize it, or the box itself to move it, and the ticks follow (pins you ticked by
  hand outside it are left alone). Around the box the map drags as usual. **Done** (or Esc) takes the box away and
  leaves the ticks. The map zooms to whatever the filters show. Drag its bottom edge to resize it, use **Full screen**
  (Esc leaves) or **Hide map**; it remembers your choice. Properties without a map location are counted above it.
- **Workload:** each crew's booked hours for each day of the week (time on site plus the drive on its route)
  against its **hours per day** (set on the crew), with holidays marked. With work orders selected, click a day
  (or a crew's day) to schedule them into it.
- **The list:** **Columns** picks and orders them: drag a column's name up or down to move it, **✕** hides it
  (Property stays first; **Reset** puts back service, MC,
  eligible from, due by, est. hours, sq ft, price and badges); click a heading to sort. The top row totals what's
  shown; the bar above adds up what's selected, with **By crew and service**. **Export** downloads the shown (or
  selected) rows as a spreadsheet.
- **Estimated hours** fill themselves in. Hover them to see where they came from:
  - **~0.6** (with ~): from the lawn size, using the service's **setup minutes** and **minutes per 1,000 sq ft**
    (set them on the price list, e.g. 5 + 3, so a 10,000 sq ft lawn is about 35 minutes).
  - **0.7**: from the property's own visits of that service (Arrived to Completed), recent ones counting more. One
    or two visits are blended with the size estimate; from three on, the history takes over. A visit far off the
    usual (a breakdown, a Completed tapped hours late) is left out and marked **!**.
  - **0.5 🔒**: the work order's own budgeted hours.
- **Edit work orders** schedules the selection in one step: the **date**, **truck / crew**, **appointment window**
  (left empty, each keeps its own) and **route order** (**Optimize into the route**, **Add to the end**, or **Keep
  the current order**). It shows what it adds to that crew's day ("Adds 1.8 h on site + 14 min drive. Truck 2 Tue
  Nov 24: 5.3 of 8 h") and warns about holidays, missed windows, anyone reached after their time window, and
  ones that aren't eligible yet (those need a reason). Options: **Make the crew the preferred crew** for those
  properties, and **Notify customers by their preference** (a text or an email to those who want one; the ones
  to call are listed for you). A property's contacts who are ticked to receive its service notifications, such
  as a tenant, are told as well, and counted beside the box. The crew's people are put on any work order with
  nobody on it.
  The same window is on the Dispatch board, where it can also send work back to the waiting list.
- **More (on a selection):** set the **priority**, **Skip** (with why), or **Delete** (admins; ones on an invoice stay).
- **Back to waiting list:** on a scheduled work order, choose why (rain, wind, no access, customer asked, other) with
  a note. It goes back with its date cleared, and the reason shows on the list.
- **Card on file** (Settings → Customers & billing, off to start): when it's on, work orders for customers with no
  card or bank account on file (expired cards don't count) show **Needs card** and can't be scheduled. Turn it off
  for one customer or one property in the **Scheduling** box on their page: switch on **Don't require a card on
  file for this customer** (or **property**), and a box opens for the reason (net 30, pays by check). It takes
  effect when you save the reason; switch it off to require a card again.
- **Scheduling preferences:** on a customer's page, **Pre Visit Notification**: no notice, text ahead, email
  ahead or call ahead. On a property's page, its **preferred crew** and its own notification (or the same as the
  customer's). When you schedule work, move it to another day or send it back to the waiting list with **Notify
  customers by their preference** ticked, Crewdesk texts the ones who chose a text, emails the ones who chose an
  email (to the address on their account, as a service notice with no unsubscribe link), and lists the ones to
  call. Anyone it couldn't reach (no mobile number, no email address) is counted so you can call them instead.

## Crews

**Team → People → Crews** (Customers & billing managers), like Homeworks' crews: the teams you send out, such as
"Spray crew" or "Mowing 1".

- **Add crew:** a **name**, a **color** (it shows on work orders), the **crew lead**, the **members** and the
  **truck or equipment** they take (from Fleet), plus notes and **hours per day** (8 to start; the waiting list's
  workload strip measures their day against it).
- **On work orders:** pick the crew on the work order form and its people are filled in. The crew shows on the
  work order, the Work orders list (with a **Crew** filter), the calendar (a **Crew** filter, and the crew's name on
  each card) and the crew's phones.
- **Changing a crew's people:** when you save, **Also give this crew's open work orders (today on) the new people**
  (ticked unless you untick it) updates those work orders; past and finished ones keep who did them.
- **Inactive** crews aren't offered on new work orders. Deleting a crew leaves its work orders and their people as
  they are. Each crew card has **Work orders** to see that crew's.

## Dispatch boards

There are two dispatch boards for now, both under **Schedule** (Customers & billing managers): **Dispatch**, built
from the Crewdesk plan (laid out like the waiting list), and **New Dispatch** with a **Beta** tag, a copy of
Homeworks' New Dispatch. They show the
same work orders, crews, routes and stop numbers, so a change made on one shows on the other. Use both; one will
be kept.

**How drive times are worked out:** to start, drive times and miles come from **real roads**: a routing service
works out the actual drive along the streets, which also gives the route's line on the map, turn-by-turn
directions when you print a route, and curbside arrival. Only map coordinates are sent to it, never names or
addresses. New routes also start with **curbside arrival** on (the truck pulls up on each stop's own side of the
street); any one route can be switched while you order it.

An admin can change both on the New Dispatch board: **View → Routing and capacity…**. **Estimates** work drive
times out from the straight-line distance instead, with nothing leaving Crewdesk (the board then says the times
are estimated, and curbside arrival is greyed out). If the routing service can't be reached, Crewdesk uses
estimates for that route so one can always be built. The free public OpenStreetMap service is used unless you
enter another server's address; it is meant for light use, so a busy company may want its own. The same window
sets where routes start and end (your company address unless you type another) and each person's daily hours.

### Dispatch board (from the Crewdesk plan)

**Schedule → Dispatch** is the waiting list's page for the work that has a day. It's laid out the same way: the view
picker and filters on top, then the map, the week's workload, and the list. Select work orders on the map or the
list, then **Edit work orders** to move them.

- **The view picker** (top left) switches between the two boards, **Waiting list** and **Dispatch board**, and
  holds this page's views: ready-made ones (Dispatch board, Not done yet, No crew yet, Done or skipped) and your
  own. **Save view** keeps the filters, columns and sort, just for you or shared with everyone.
- **The day:** the arrows, the date box and **Today** pick the day; **Week** shows seven days at once. Clicking a
  day in the workload strip opens that day.
- **Filters** show as chips (✕ removes one). They're the waiting list's (service, tag, Map Code, city, ZIP,
  priority, badge and so on) plus **Truck / crew** and **Status**. They apply to the map and the list.
- **The map:** each stop is a **numbered pin in its crew's color** (the number is its place in the route), each
  crew's route is drawn as a line, and the shop is marked. Click pins to select them, or use **Group Selection** (a box you drag on the map, then resize or move; see the
  waiting list's map above). **Full
  screen**, **Hide map** and dragging the bottom edge work as on the waiting list. With **Waiting list pins**
  ticked, waiting-list services that match the filters show as **gray pins**: select them the same way and Edit
  work orders puts them on the day.
- **Workload:** each crew's hours for each day of the week, time on site plus the drive on its route, against its
  hours per day. The day you're looking at is highlighted. With work orders selected, clicking a day (or a
  crew's day) opens Edit work orders for that day.
- **The list** is grouped by truck or crew, each crew's stops in route order with the stop number first. Each
  crew's heading shows its truck and people, stops, square feet, and its day, e.g. "5.9 h on site + 1.4 h drive
  = 7.3 of 8 h" (red when over), when it leaves and gets back, and **To load** (the tank mix and products its
  open stops need, from Chemical Tracking). The **totals row** adds up what's shown; the selection's hours,
  square feet and dollars show above the list. **Columns** picks and orders the columns (drag a name to move it; Property stays first);
  besides the waiting list's there are **Arrives about**, **Status**, **Notes**, **Drive (min)**, **Truck / crew**,
  **Technicians** and **Date**. Click a column heading to sort by it (the grouping goes away;
  **Group by crew** or the **#** heading brings it back).
- **Status and notes update on their own** every minute as crews start and finish (Open, On site, Done, Skipped).
  **Notes** opens the notes between the office and the crew on that work order.
- **Edit work orders** (the window): **Move to** the **Dispatch board** or the **Waiting list**.
  - Dispatch board: the **date**, the **truck / crew** (or keep each one's), an **appointment window**, and the
    **route order**: **Optimize into the route**, **Add to the end**, or **Keep the current order**. Before you
    save it shows what that adds ("Adds 1.8 h on site + 14 min drive. Truck 2 Tue Nov 24: 5.3 of 8 h"), in red
    when the crew would be over, and lists anyone who would be reached after their time window. Options: make
    the crew the properties' **preferred crew**, and **notify customers** by their preference when their day
    changes.
  - Waiting list: why (rain, wind, no access, customer asked, other) and a note. They come off their routes.
- **Drag a row** onto another row to change its place in the route, or onto another crew's heading (or its rows)
  to give it to that crew; in the week view that can also be another day. The crew's heading shows what the drop
  would do while you hold it there.
- **Route stops** (the button above the map, on a crew's heading, or in the bar when rows are ticked) opens one
  crew's day as a list to put in order. Pick the **Crew** at the top if it isn't the one you want.
  - **By hand:** drag a stop by its handle (⠿) to where you want it, or click the handle and press the up and
    down arrow keys. **Reverse** turns the whole order around. If you ticked stops on the board first, **Ticked
    first** puts those at the front in the order you ticked them.
  - **Optimize** lets Crewdesk order the stops for the shortest drive, from the shop and back, keeping locked
    stops where they are. You can still drag stops afterwards.
  - **Curbside arrival** plans the drive so the truck pulls up on each stop's own side of the street, so nobody
    crosses the road. It can add a little driving (a trip round the block). It needs real-road drive times; on
    estimates the box is greyed out and says so. Where the routing server can't reach a stop from its own side,
    the route is measured the ordinary way and the window tells you.
  - Each drive, each arrival time and the totals are measured again as you change things. Nothing changes on
    the board until **Save order**. The crew's route then keeps the order and the curbside choice through later
    changes (dragging a row, Optimize, moving a stop off it).
- **Routes other ways:** drag rows on the board itself; click pins on the map in the order they should be
  visited and choose **More → Route in the order selected**; **Optimize** on a crew's heading (or **Optimize
  routes** for every crew) to order them from the shop and back with the least driving; or click the **lock** by
  a stop number to keep that stop at its place, and Optimize orders the others around it.
- **More** (on a selection): back to the waiting list, route in the order selected, lock or unlock, set the
  priority, skip (with why), or delete (admins).
- **Rain or wind day…** (or **Rain day** on a crew's heading) moves the whole day's, or one crew's, open work
  orders in one step: to another day (the next working day is filled in) or back to the waiting list, with why.
  Ones already started, done or skipped stay.
- **Waiting list** (the last heading in the list): **Show them** lists the waiting-list services that match the
  filters under the day's work, so you can pick from them; filtering by Map Code shows them automatically.

### New Dispatch (Beta)

**Schedule → New Dispatch** is laid out like Homeworks' New Dispatch: a list or board of the day's events beside a
map. It shows work orders and to-dos.

- **Top row:** **Day ▾** (day, week, month or your own dates), the date, the arrows and **Today**; **Table/Board**,
  **Split** or **Map**; the **waitlist** button; **Print**; a button to switch to the other board; and **View**.
- **Table or Board:** the table has a row per event; **Board** groups them into a column per crew or person with
  their hours against capacity, and you can drag a card to another column to reassign it.
- **+ Filter** adds filters (status, assignment, service, tag, Map Code and more) as chips; the search box finds
  events by name, customer or address.
- **View:** show or hide columns and drag them into order, choose the details on the board's cards, **Color events
  by…** (routing status, assignment, service, event type or weekday, with a legend on the map), show dispatch notes
  in the list, and **Routing and capacity…**.
- **A row's ⋮ menu** (or right-click a pin): open it, **Reschedule**, assign, **Move to waitlist**, **Duplicate**,
  **Unassign**, **Remove from route**, contact the customer by text or email, or **Delete**. Click the status to mark
  it Open, Complete or Skipped. Click a row to open the **Work View** panel with everything about it.
- **Select** rows with the checkboxes, pins by clicking, or many pins with the **lasso** on the map. The bottom bar
  then offers the same actions for all of them. With nothing selected it shows the day's totals.
- **Route stops** (or **Assign**) builds a route from the selected events: drag the stops into order or use the
  arrows, pick where it starts and ends (the company address, a person's home, a custom address or a spot on the
  map), set the start time and how arrival times are shown, **Optimize** or **Reverse**, then **Save**. **Save and
  apply to future weeks** copies the order to the same weekday in the weeks ahead for visits that repeat. A route
  holds up to 100 stops.
- **Curbside arrival** (a tick box in the yellow bar while you order a route): the drive is planned so the truck
  pulls up on each stop's own side of the street. The route remembers it. It needs **Real roads** under
  **View → Routing and capacity**; the same window has **Curbside arrival on new routes**, which decides whether
  the box starts ticked (an admin sets it). Both dispatch boards share the routes, so a choice made on one shows
  on the other.
- **Moving a stop** to another day, another crew or the waitlist takes it off its route, and the rest renumber.
  Stops with no route show **00**.
- **Custom areas:** draw areas on the map, name and color them, and hide or show them; everyone sees the same ones.
- **Waitlist panel:** the waiting list beside the day; add one to the day you're looking at.
- **Print:** the route map, turn-by-turn directions (with real roads on), or the list of stops.
- Not in this copy yet: opening the map in its own window, traffic, and custom-field columns.

## Calendar

**Schedule → Calendar** (Operations) shows everything with a date in one place, laid out like Homeworks'
calendar: **Work orders**, **To-dos**, **Repair orders** (by due date), **Time off** (approved), **Holidays** and **Shifts**.

- **Views:** **Day**, **Week** and **Month** (the menu by the date, or press **D**, **W** or **M**), and **‹ Today ›**
  to move (or the arrow keys, and **T** for today). Click the date for a month to jump to any day. The two buttons
  on the right of the toolbar switch between **calendar** and **list** (each day's events in rows).
- **The side panel:** the month (click a day to go there), **Sort events** (time, budgeted hours, customer A-Z,
  status or event type) and **Event types**: tick the ones to show (Shifts start hidden, since every shift for
  everyone fills the calendar fast). Point at a type and click the pencil to change its color (or any color with
  **+**); **High contrast** fills the cards with the color. **Color by event type** (brush) colors cards by type;
  turn it off to see each to-do in its own color. **Group by event type** (layers) puts each day's events under
  their type. Hide the panel with the button at its bottom (the toolbar's panel button brings it back).
- **Filter:** **+ Filter** adds a filter you can remove: **Status** (open or done), **Repeats** (repeating or
  one-time), **Person**, **Customer** or **Tag** (the customer's tags, and a work order's own tags). **Search events** finds a title, customer,
  address, note or person.
- **Toolbar buttons:** the hourglass opens the **Waitlist** (work orders with no date and repair orders with no due date); the sliders choose
  what each card shows (time, address, customer, people, price, hours, photos, type, status, notes); the clock shows **budgeted
  hours by person** under each day; **…** has Add a to-do, Print, Export and Reset calendar settings.
- **Each day** shows how many events and the budgeted hours (to-dos and repair orders). The bottom shows the total
  for the range, **Print** and **Export** (a spreadsheet of the events shown).
- **Click an event** to see everything about it, then **Open** it, **Mark done** (to-dos) or **Complete** (repair
  orders), or **Move to** another date.
- **Drag and drop:** drag a to-do or repair order to another day to move it (a multi-day to-do keeps its length);
  drag one from **Unscheduled** onto a day to give it a due date. Whoever made a to-do or a manager can move it;
  fleet managers move repair orders.
- **Add a to-do:** point at a day and click **+** (or **Add to-do** in Day view); the form opens with that date.
- **Who sees what:** your own to-dos (managers everyone's), every repair order, your own time off (time-off and
  schedule managers everyone's), the published shifts (schedule managers drafts too) and the holidays.
- Your choices (view, sort, types, colors, card details) are kept for you in that browser.

## Custom fields

Your own fields, like Homeworks' Custom Fields: "Gallons used" on work orders, "Grass type" on properties,
"Referred by" on customers, "Tag number" on equipment. Open **Resources → Custom fields** in the Operations menu
(or **Settings → Custom fields**). Owners and admins add and change them; everyone else sees and fills them in.

- **New field** (Homeworks' "Add New Field"):
  - **Applies to:** Customers, Properties, Work orders, To-dos, Invoices or Equipment.
  - **Field name / label.**
  - **Field type:** Text, Checkbox, Date, Decimal or Integer, as in Homeworks, plus **Dropdown** (a list of
    choices you type, one per line).
  - **Transferable field:** a new record copies this value from a field with the same name on the record it's
    made for:
    - a work order or to-do copies from its property, then its customer;
    - an invoice made from a work order copies from the work order, then the customer;
    - a property copies from its bill-to customer.
    For example, a work order field named Gate Code or Total ft fills from the property's field of the same
    name. Fields on work orders and to-dos named Front Yard Sq Ft, Back Yard Sq Ft, Total Sq Ft or Lawn Sq Ft
    also fill from the property's sizes, whatever those are called now.
  - **Default value:** what a new record starts with. A value typed in, or a transferred one, comes first.
- **The list** shows each field's type, what it applies to, its default and Transferable, with **Applies to** and
  **Search** filters.
  - Click a name to rename it, or to change a dropdown's choices.
  - Type a default and click **✓** to save it, and tick **Transferable** on or off.
  - **Drag a field by its handle** (the six dots at the left) to change the order fields show in on forms and
    pages. A field moves among the fields for the same kind of record.
  - **Delete** removes one field, or tick several and **Delete selected**. Deleted fields' values stop showing
    everywhere.
  - **Crewdesk's own property fields** (Map Code, Front Lawn ft, Back Lawn ft, Other ft, Total ft, Gate Code,
    Pets, Access Notes, Notes) are in the list too, each with a line saying what Crewdesk uses it for. Rename
    them and move them like any field; they have no Delete, because Crewdesk needs them. To take one off the
    property page, hide it in the layout editor. A service can be priced from any **Decimal** or **Integer**
    field on properties (see **Priced from** under the price list).
- **Filling them in:** the customer, property, work order and to-do forms have a **Custom fields** box.
  - Each field has an input.
  - **Reset to defaults** puts the defaults back, and **Clear** empties them all.
  - Owners and admins also see **Add custom field**, which adds one without leaving the form.
  - On a new record the defaults are filled in. A transferable field left blank says where it will be filled from.
- **On each page:** customers, work orders, to-dos, invoices and equipment have a **Custom fields**
  card. Click **Edit**, change the values, then **Save custom fields**. A property's fields are in its
  **Property** box instead (**Edit details**).
  - Customers, properties and invoices: Customers & billing managers can change them.
  - Work orders: managers, or the crew on the work order.
  - To-dos: managers, whoever made it, or the people it's for.
  - Equipment: Fleet managers.
- **For the crew:** a work order's page and a to-do's job sheet list the property's custom fields (yard sizes and
  so on) beside the gate code and access notes. The phone shows them on each work order and to-do in the Tasks tab.

## To-dos

To-dos are jobs for the office or the crew, like Homeworks' to-dos: "call the HOA about the gate code", "fix
the sprinkler head at Jane's", "clean the sprayers every other Monday". Open them from **Schedule → To-dos** in the
Operations menu, the to-do button in the top bar, **+ New → To-do**, or the **To-dos** box on a customer's or property's page.

- **Adding one** (**Add to-do**), laid out like Homeworks:
  - **To-do title or description** (required).
  - **Customer:** pick a customer and one of their properties (people with Customers & billing access), and/or
    type a **Location** (the shop, a supplier, any address). Pick one of Homeworks' 15 **Colors** (Default, Boston
    Blue, Green, Bold blue, Blue, Turquoise, Light green, Bold green, Yellow, Orange, Red, Bold red, Purple, Gray,
    Dark Gray) to tell kinds of to-dos apart on the calendar.
  - **Scheduling:** **Single to-do** or **Recurring series of to-dos**.
    - A single to-do has a **Date**, **Multi-day?** (an end date), **Time** (start and optional end) and **Budgeted hours**.
    - A recurring series asks **How often will these to-dos be?**
      - **Daily:** every weekday (Monday to Friday) or every N days.
      - **Weekly:** every N weeks on the days you tick. It starts on the first ticked day on or after the
        starting date.
      - **Monthly:** on day D (shorter months use their last day), or on the first, second, third, fourth or
        last weekday you pick, every N months.
      - **Yearly:** on a month and day, or on the Nth weekday of a month.
    - Then how it ends:
      - **The last date you'll make a to-do** (up to 5 years ahead).
      - **Total number of to-dos** (up to 500).
      - **No end date**: they carry on. Crewdesk keeps to-dos made a year ahead and tops them up as time passes.
    - **Pause during off-season** skips the dates in a saved off-season, like Winter from December 1 to February
      28. **Add season** saves a new one (managers of to-dos or of customers).
    - The blue box says when the first to-do will be and when the last one will be.
  - The chart beside the date shows the **budgeted hours already booked** each week for the next five weeks
    (to-dos and work orders) for the people picked. The lighter part of a bar is the to-do you're adding, so you
    can spot a light week.
  - **To-do category:** pick one, or **Add new category** (managers). Categories also filter the To-dos page.
  - **Description / notes**.
  - **Employees:** pick a **Crew** (managers) to tick its people, then change them if needed; or tick people
    yourself. Nobody ticked means it's for nobody in particular; managers see it on the To-dos page. Without
    To-dos manager access you make to-dos for yourself.
  - **Photos / documents:** drop or pick photos, PDFs or short videos (MP4, MOV), up to 25 MB each. For a
    series they go on the first to-do.
- **Who sees what:** you see the to-dos that are for you and the ones you made. Managers (the **To-dos** area on
  the Permissions page) see everyone's and can give to-dos to anyone or a crew. People a to-do is for get a
  notification when it's given to them, and a reminder the morning it starts (turn these off under Notification
  settings → To-dos).
- **The To-dos page** lists them under **Overdue**, **Today**, **Tomorrow** and each later day, with how many
  and the budgeted hours for each day. Each one shows its category, ↻ for a series, **working** while someone's
  timer runs, and 📎 / 💬 counts of photos and notes. Filters: **Show** (To do or Done), **For** (managers:
  everyone, me, nobody assigned, or one person), **Through** (the next 2 weeks, month, 3 months or everything),
  **Category** and **Search**. Managers can rename or remove categories and off-seasons under **Categories and
  off-seasons** at the bottom. Removing a category keeps its to-dos.
- **Ticking off:** tick the box by a to-do (here, in the top bar's list, or on the phone). Untick it to undo.
  Done ones move to **Show: Done**, with who did it and when.
- **The job sheet** (Homeworks' "Work Order" view of a to-do): **Open job sheet** on a to-do, or click one in
  search, the calendar, a notification or the top bar.
  - A printable table: **Status**, when, **Type** (Single, or Recurring and how), category, customer, property,
    location, crew, employees, **Property notes** (gate code and access notes), **Visit notes**, **Notes for
    dispatcher**, **Budgeted hours**, tracked time, and who made it. Buttons: **Print**, **Directions**,
    **Edit to-do** and **Return**.
  - **Work tracking:** **Start work** starts a timer and **Stop work** keeps the time; start again to add more.
    **Done** (or **Mark done**) finishes the to-do and stops the timer. The calendar shows a to-do being worked
    on as on site, with its tracked time.
  - **Notes for the dispatcher:** **Add new note** leaves a note for the office: a cracked lid, a locked gate,
    parts to order. Whoever made the to-do and the people it's for get a notification. Whoever wrote a note, or
    a manager, can remove it.
  - **Photos & documents:** add more, open one to view, caption, download or remove it.
- **Editing:** **Edit to-do** on the job sheet (whoever made it, or a manager). Like Homeworks, **Delete** and
  **Complete** sit at the top while you edit. For a repeating to-do you choose **just this one** or **this one and
  the later ones** that aren't done. Moving the date moves the later ones by the same number of days.
  **Delete this and later** stops the series.
- **Repeating to-dos** are made one per date (↻ marks them). A customer's or property's page and search show
  each series once, with how many more are coming.
- **Your page:** the **My Tasks** box lists your to-dos for the next week, along with repair orders and
  onboarding steps.
- **On the phone** (Tasks tab): your to-dos for the week, with the category and repeat, the address (tap for
  directions), gate code and notes. Buttons: **Start work** / **Stop work**, **Done**, **Add photo** and **Note
  for office**.

## Spray Mix Calculator

Enter the tank size in gallons and tap **Update total** to see how much of each product to add.
Admins choose which employees can edit products, rates and mixes; every change is logged under
**Change history**.
Editors can change the order of the products: drag a row up or down by its handle (⠿) at the left, on a
computer or a phone, or focus the handle and use the up and down arrow keys. The new order is saved for everyone.

## Weather

**Resources → Chemical Tracking → Weather** keeps the weather on chemical applications for the records. It's a tab
along the top of Chemical Tracking, after Customer notices. (It used to be under Field; old links to it still
work, and typing "weather" in **Search** finds it.)

**Who can use it:** the same people as the rest of Chemical Tracking: admins, and the people an admin adds on
Chemical Tracking's **Access** tab. Nobody else sees the Weather tab or the Weather box on a work order, managers
included; add a manager on the Access tab if they should handle it. Techs who aren't on that list never see or
enter weather: the phone only stamps the location when a work order is completed.

- **Which work orders:** tick **Chemical application** on a service in the price list (Resources → Products &
  services). Work orders with one of those services get the weather when they're completed. They show
  **chemical** in the price list.
- **Settings** (admins; **Change** at the top of the page):
  - **Automatic** (to start): wind speed and direction, gusts, temperature and the last 24 hours' rain come from the
    nearest **National Weather Service** station for the property's map location at the time it was completed. If
    the station hasn't reported yet, Crewdesk tries again every 15 minutes (for up to a week, which is as long as
    stations keep readings). A property with no map location uses the phone's location from when it was completed.
  - **Manual:** the office enters **the day's weather** once, and it goes on every chemical application completed
    that day, including ones completed after it's entered.
  - **Off:** nothing is recorded.
- **The list** shows completed chemical applications for the dates you pick, with **Needs weather** (still waiting,
  and why: not reported yet, no map location) and **All** tabs.
  - **Enter weather** / **Edit:** type the wind, direction, gusts, temperature, rain and a note. It's marked
    **Entered by the office** and kept as is.
  - **Look up:** gets it from the Weather Service now, replacing what's there.
- **The day's weather** (any mode): pick a day and enter it once. In automatic mode it fills in only that day's
  applications still waiting for weather; automatic and office readings are kept. **Delete this day's entry** takes
  it back off.
- **On the work order** (for the same people): a completed chemical work order's page has a **Weather** box with the reading, where it
  came from (the station and time, the day's entry, or who typed it), and the **GPS** stamp. The phone
  app adds the GPS stamp when **Completed** is tapped, if location is already allowed (it never asks just for this).
- **Undo** on a completed work order clears its weather; it's looked up again when it's completed again.

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

Connects to Bigcapital (the company's accounting system). Customers, invoices and payments are sent as they happen
(see Billing under Customers & Properties). Approved pay periods can post as journal
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
inspections, issue reports, repair orders, work orders, to-dos, training, onboarding tasks and signing documents.
- **Updates:** the app updates itself. A new version is downloaded in the background and used the next time
  the app is opened; if the app was left open, a blue **Update** button shows at the top instead (tap it and the
  app restarts on the new version in a few seconds; save what you're in the middle of first). The bottom of the
  **Me** tab shows the version and when it was last updated, with **Check for updates**. Now and then a change
  needs a new version from the App Store or Google Play; the office will say when.
- **Work orders** (Tasks tab): yours for the next week with the customer, the address (tap it for directions), gate
  code, pets, the services, tags and notes, **Visit forms** to fill in and sign (tap one), **Add photo** (take one
  or choose several), and **Arrived**, **Completed** (with notes) and **Skip** (with a reason).
- **Text messages** (the 💬 by the bell, for the people picked to answer texts and Customers & billing managers):
  every conversation on the company's number, newest first, with unread ones marked. Tap one to read it and answer
  from the phone; **Mark unread** and **Mark done** are at the top. A notification for an incoming text opens its
  conversation. Pictures customers send show in the conversation, the 📷 button texts one back (take a photo or
  choose one), **Make it mine** takes the conversation so only you are told about its texts, and **Mine** in the
  list shows yours.
- **To-dos** (Tasks tab): yours for the next week with the category and repeat, the customer, the address (tap
  it for directions), gate code and notes; **Start work** / **Stop work** (time tracking), **Done**, **Add photo**
  and **Note for office** (a note for the dispatcher). **Quick add** makes one for yourself for today or tomorrow.
