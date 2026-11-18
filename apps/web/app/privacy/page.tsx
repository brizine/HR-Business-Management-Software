import type { Metadata } from "next";

/**
 * Public privacy policy for the Crewdesk website and phone app (linked from the App Store and Google
 * Play listings). Describes what Crewdesk actually collects; review with your attorney before relying
 * on it, and update it when features change.
 */
export const metadata: Metadata = { title: "Privacy Policy · Crewdesk" };

const COMPANY = "ProSpray Lawn & Pest";
const EFFECTIVE = "November 17, 2026";
/** Where people send privacy questions and requests. */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_PRIVACY_EMAIL || "info@prospraylawns.com";

export default function Privacy() {
  return (
    <main className="legal">
      <h1>Privacy Policy</h1>
      <p className="muted">Crewdesk Management website and app · Effective {EFFECTIVE}</p>

      <p>
        Crewdesk is the employee management system {COMPANY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) uses for scheduling, time
        tracking, time off, payroll, training, documents, and vehicle and equipment maintenance. This policy explains what
        information the Crewdesk website (management.prospray.net) and the Crewdesk phone app collect, how it is used, and
        the choices you have. Crewdesk is for our employees and job applicants; accounts are created by us, not by the public.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li><strong>Account and contact details:</strong> your name, work email, phone number, job title, department, role,
          employment type, start date, home address, emergency contact and, if you add one, a profile photo.</li>
        <li><strong>Employment and payroll records:</strong> pay rate and pay history, hours worked, overtime, bonuses and
          reimbursements, time-off balances and requests, attendance, performance reviews and disciplinary records, and
          training progress.</li>
        <li><strong>Tax and payment forms:</strong> information you enter on W-4, I-9 and direct-deposit forms, including your
          Social Security number and bank account details. These are encrypted and visible only to you and payroll
          administrators.</li>
        <li><strong>Location:</strong> the phone app requires location access while you use it. Your location is recorded
          when you clock in and out, and about every 5 minutes while you are clocked in with the app open, to verify job-site
          attendance. <strong>Location is not recorded when you are off the clock or when the app is closed.</strong> On the
          website, location is used only if you allow it when clocking in or out.</li>
        <li><strong>Photos and documents you upload:</strong> for example onboarding documents (such as a driver&apos;s
          license), signed forms, fuel receipts and photos of equipment. The camera is used only when you choose to take a
          photo or scan an equipment QR label.</li>
        <li><strong>Vehicle and equipment information:</strong> meter readings, fuel purchases, inspections and work orders
          you log.</li>
        <li><strong>Device and usage information:</strong> a push-notification token for your device, the device type, sign-in
          times, and the IP address and browser used to sign in (kept for security and to protect your account).</li>
        <li><strong>Electronic signatures:</strong> your typed name, the date and time, and the IP address when you sign a
          document.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run your employment: schedules, time records, time off, payroll, benefits, training and compliance records.</li>
        <li>To verify attendance at job sites and keep crews and equipment safe.</li>
        <li>To maintain vehicles and equipment and track their costs.</li>
        <li>To send you notifications (in the app, by push notification, by email, or by text message if you opt in). You
          choose which notifications you receive in Settings → Notifications on the website.</li>
        <li>To secure accounts (including two-factor sign-in) and to meet legal, tax and recordkeeping requirements.</li>
      </ul>
      <p>We do <strong>not</strong> sell your information, use it for advertising, or share it with data brokers.</p>

      <h2>Who can see it</h2>
      <p>
        Inside {COMPANY}, access depends on role: you see your own information; managers and administrators see what they
        need to manage their teams (for example schedules, time records and location while clocked in); payroll
        administrators see pay and tax information. We share information outside the company only with service providers who
        help us run Crewdesk, under obligations to protect it, or when required by law:
      </p>
      <ul>
        <li>Website and database hosting (SiteGround) and encrypted backups.</li>
        <li>Email delivery, and text-message delivery (Twilio) for people who opt in to texts.</li>
        <li>Push notifications through Expo, Apple and Google.</li>
        <li>Payroll and accounting services we use to pay you and keep our books.</li>
        <li>Government agencies, courts or others when the law requires it.</li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        We keep employment, payroll and tax records for as long as you work with us and afterwards for the periods the law
        requires. Location points recorded while you are clocked in are deleted automatically after 180 days. Other
        information is deleted when it is no longer needed.
      </p>

      <h2>Security</h2>
      <p>
        Information is sent over encrypted (HTTPS) connections. Uploaded files and sensitive fields such as Social Security
        and bank numbers are encrypted when stored. Accounts are protected by passwords and, for administrators, two-factor
        sign-in. No system is perfectly secure, so please keep your password private and tell us right away if you think your
        account has been misused.
      </p>

      <h2>Your choices and rights</h2>
      <ul>
        <li><strong>See and correct your information:</strong> in the app under Me → My Info, or on the website. Ask your
          manager or our office to correct anything you can&apos;t change yourself.</li>
        <li><strong>Location:</strong> you can turn location off in your phone&apos;s settings at any time, but the app needs it
          to work, and clocking in may require it.</li>
        <li><strong>Notifications:</strong> change them on the website under Settings → Notifications; text messages stop
          if you reply STOP.</li>
        <li><strong>Requests:</strong> you may ask for a copy of your information or ask us to delete information we are not
          required to keep. Depending on where you live (for example California), you may have additional rights under state
          law, and we will not treat you differently for using them.</li>
      </ul>

      <h2>Children</h2>
      <p>Crewdesk is not intended for children under 16, and we do not knowingly collect information from them.</p>

      <h2>Changes</h2>
      <p>If we change this policy, we will update the date above and, for significant changes, let users know in the app or
        by email.</p>

      <h2>Contact us</h2>
      <p>
        Questions or requests about your privacy: {CONTACT_EMAIL
          ? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          : <>contact the {COMPANY} office or your manager</>}.
      </p>
    </main>
  );
}
