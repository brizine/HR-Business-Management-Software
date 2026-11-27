"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";

/**
 * Marketing: kept in the menu for what's coming (the website and the like). Nothing lives here yet;
 * its old pages (Templates, Automations, Documents, Visit Forms, Text) are under Resources, and
 * this page says so to anyone who comes looking.
 */
export default function MarketingPage() {
  const { me, can } = useAuth();
  const office = can("manager", "customers");
  const moved: [string, string][] = [
    ...(office ? [["/templates", "Templates"], ["/automations", "Automations"], ["/docs", "Documents"], ["/visit-forms", "Visit Forms"]] as [string, string][] : []),
    ...(me?.access?.texting ? [["/texts", "Text"]] as [string, string][] : []),
  ];
  return (
    <>
      <PageHead title="Marketing" sub="Nothing here yet. This is where your website and other marketing tools will go." />
      {moved.length > 0 && (
        <div className="card stack">
          <strong>Looking for something that used to be here?</strong>
          <p className="muted" style={{ margin: 0 }}>These pages are under <strong>Resources</strong> in the left menu now. They work exactly as before.</p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {moved.map(([href, label]) => <Link key={href} href={href} className="btn">{label}</Link>)}
          </div>
        </div>
      )}
    </>
  );
}
