# Try Crewdesk in GitHub Codespaces

Run the whole app (website and API, with a demo company) in your browser. Nothing to install.

## Start it

1. On GitHub, open the repository and click **Code → Codespaces → Create codespace on main**
   (or use https://codespaces.new/brizine/HR-Business-Management-Software).
2. Wait for setup (the first time takes about 3–5 minutes). A terminal named **crewdesk** sets up the
   database, loads demo data and builds the app.
3. When it says it's listening on port 3000, Crewdesk opens in a new browser tab. If it doesn't, open
   the **Ports** tab at the bottom and click the globe icon next to **Crewdesk (3000)**.

## Sign in

Every demo account's password is `password123`:

| Email | Role | Good for trying |
| --- | --- | --- |
| `owner@demo.test` | Owner | Everything: payroll, settings, who can edit the Spray Mix Calculator |
| `manager@demo.test` | Manager | Schedules, approvals, timesheets; a chosen Spray Mix editor |
| `tech@demo.test` | Employee (mechanic) | Work orders, inspections |
| `crew@demo.test` | Employee (driver) | Clocking in, time off, shifts, the employee view |

Open a second browser (or a private window) to be two people at once, for example a crew member
asking for time off while the manager approves it.

On your phone, open the same Codespaces address in the phone's browser to see the mobile layout.
(The installable phone app needs an Expo build; see the README.)

## Things to know

- **It's a demo.** Data lives in the codespace and is deleted with it. Don't enter real employee
  information.
- **Email and texts don't send** (no email or Twilio account is set up). Invites show a link to copy
  instead.
- **Location:** clock-in location works if the browser shares it; the demo's job sites are in
  Austin, TX.
- **Stopping:** Codespaces stop after 30 minutes of inactivity. To restart the app, run `pnpm demo`
  in the terminal.
- **Cost:** personal GitHub accounts include free Codespaces hours each month (about 60 hours on
  the smallest machine). Delete codespaces you're done with under
  https://github.com/codespaces.
- **Sharing:** by default the address only works for you. To let someone else try it, in the
  **Ports** tab right-click port 3000 → **Port Visibility → Public**, and send them the address.
  Anyone with the link can then reach the demo, so switch it back to private afterwards.
