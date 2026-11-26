# App Store submission: ProSpray Management (iOS)

Everything to paste into App Store Connect for the first release. Bundle ID `net.prospray.crewdesk`,
the version in `apps/mobile/app.json` (1.1.0 at the time of writing), iPhone only. After the first
release most changes reach phones without another submission: see
[Phone app updates](phone-app-updates.md).

## App Review Information

**Sign-in required:** Yes

**Demo account** (create a test employee whose data is safe to show, and fill in before submitting):

- User name: `__________________`
- Password: `__________________`

Give the demo account at least one published shift this week, so the reviewer sees the schedule,
and leave it on the Employee role.

**Notes** (paste as-is):

> ProSpray Management (built on Crewdesk) is the internal employee management app for ProSpray Lawn & Pest, a lawn care and pest
> control company. It is used only by our employees; accounts are created by the company (there is
> no public sign-up in the app). Employees use it to clock in and out, see their schedule, request
> time off, log fuel and vehicle meter readings, complete equipment inspections, take training and
> sign documents.
>
> **Location:** The app asks for location "While Using the App". It records the employee's location
> when they clock in and out, and about every 5 minutes while they are clocked in and the app is open,
> to verify attendance at job sites (a common requirement for field crews and for payroll accuracy).
> Location is never recorded when the employee is off the clock or when the app is closed, and
> background location is not used. Employees are told this on the location screen and in our privacy
> policy. Because accurate, verified time records depend on it, the app asks employees to enable
> location to use it.
>
> **Camera / photos:** used only when the employee chooses to scan an equipment QR label or
> photograph a document, fuel receipt or profile photo.
>
> **How to test:** Sign in with the demo account above. The Clock tab clocks in and out (allow
> location when asked). Schedule shows shifts as a list, week or month. Fleet → an asset → Log fuel.
> Me → Documents opens documents. Push notifications are sent for schedule changes, time-off
> decisions and similar events.
>
> **Account deletion:** accounts are created and closed by the employer (an administrator deactivates
> a former employee's account); employees can request deletion of their information as described in
> the privacy policy.
>
> Privacy policy: https://management.prospray.net/privacy

**Contact information:** your name, phone and email for Apple to reach you during review.

## Store listing

- **Name:** ProSpray Management (the home-screen label under the icon is "ProSpray", set in app.json)
- **Subtitle** (30 characters): `ProSpray team management`
- **Category:** Business (secondary: Productivity)
- **Privacy Policy URL:** https://management.prospray.net/privacy
- **Support URL:** https://management.prospray.net/support (public page with contact email and common questions)
- **Keywords** (100 characters): `time clock,schedule,timesheet,time off,crew,fleet,maintenance,fuel log,inspection,employee`
- **Promotional text** (optional): `Clock in, check your schedule and log fuel from the field.`

**Description:**

> ProSpray Management is the ProSpray Lawn & Pest team app.
>
> • Clock in and out, with your hours for the week and pay period
> • See your schedule as a list, week or month; pick up open shifts
> • Subscribe to your shifts in Apple or Google Calendar
> • Request time off and see your balances
> • Log fuel and meter readings, scan equipment QR labels, run pre-trip inspections and report issues
> • Work orders, training courses, documents to read and sign
> • Notifications for schedule changes, time-off decisions and assignments
>
> ProSpray Management is for ProSpray Lawn & Pest employees. Your account is set up by the company.

**Screenshots:** iPhone 6.9" (1320 × 2868 or 1290 × 2796), 3 to 10 of them. Good picks: Clock, Schedule
month view, Asset with Log fuel, Me tab, Documents. Use demo data, not real employees' details.

**Age rating:** answer None / No to every question (rating 4+).

## App Privacy ("Data types")

Answer **Yes, we collect data**. For each type below choose: **Linked to the user's identity**:
Yes. **Used for tracking**: No (we don't track across other companies' apps or sites).

| Data type | Collected | Purpose |
|---|---|---|
| Contact info → Name | Yes | App functionality |
| Contact info → Email address | Yes | App functionality |
| Contact info → Phone number | Yes | App functionality |
| Contact info → Physical address | Yes | App functionality |
| Location → Precise location | Yes | App functionality |
| Financial info → Other financial info (pay, bank details for direct deposit) | Yes | App functionality |
| Sensitive info (Social Security number on tax forms) | Yes | App functionality |
| User content → Photos or videos | Yes | App functionality |
| User content → Other user content (documents, signatures, notes) | Yes | App functionality |
| Identifiers → User ID | Yes | App functionality |
| Identifiers → Device ID (push token) | Yes | App functionality |
| Diagnostics | No | |
| Usage data / Advertising data / Browsing history | No | |

## Distribution

Chosen: **Unlisted App**. The app is reviewed like any other, but it doesn't appear in App Store
search; employees install it from a direct link. After the app record exists in App Store Connect,
request it at https://developer.apple.com/contact/request/unlisted-app/ (Apple replies by email,
usually within a few days), then choose "Unlisted" under Pricing and Availability → App
Distribution Methods.
