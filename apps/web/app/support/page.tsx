import type { Metadata } from "next";
import Link from "next/link";

/** Public support page for the phone app (the App Store and Google Play "Support URL"). */
export const metadata: Metadata = { title: "Support · ProSpray Management" };

const COMPANY = "ProSpray Lawn & Pest";
/** Where people send questions about the app. */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || process.env.NEXT_PUBLIC_PRIVACY_EMAIL || "info@prospraylawns.com";

export default function Support() {
  return (
    <main className="legal">
      <h1>ProSpray Management Support</h1>
      <p className="muted">Help with the ProSpray Management app and website</p>

      <p>
        ProSpray Management is the employee app for {COMPANY}. Accounts are set up by the company for our employees.
      </p>

      <h2>Contact us</h2>
      <ul>
        <li>Email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
        <li>Employees can also ask their manager or the {COMPANY} office.</li>
      </ul>

      <h2>Common questions</h2>
      <ul>
        <li><strong>I forgot my password:</strong> use <Link href="/forgot-password">Forgot password</Link> on the sign-in
          page, or ask an administrator to send a new invitation.</li>
        <li><strong>I don&apos;t have an account:</strong> accounts are created by {COMPANY}. Ask your manager or the office
          for an invitation.</li>
        <li><strong>The app asks for my location:</strong> location is recorded only while you are clocked in, to verify
          job-site attendance. Turn it on in your phone&apos;s Settings → ProSpray → Location → While Using the App. See the{" "}
          <Link href="/privacy">Privacy Policy</Link> for details.</li>
        <li><strong>I&apos;m not getting notifications:</strong> allow notifications for ProSpray in your phone&apos;s
          Settings, and choose which ones you get on the website under Settings → Notifications.</li>
        <li><strong>My hours or schedule look wrong:</strong> tell your manager; they can correct time records and
          shifts.</li>
      </ul>

      <p className="muted"><Link href="/login">Sign in</Link> · <Link href="/privacy">Privacy Policy</Link></p>
    </main>
  );
}
