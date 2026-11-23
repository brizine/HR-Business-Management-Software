"use client";
import { PageHead } from "@/components/ui";
import { AutomationsPage } from "@/components/automations";

/** Automations: emails, texts, tags and to-dos that run on their own when things happen. */
export default function Automations() {
  return (
    <>
      <PageHead title="Automations" sub="Emails, texts, tags and to-dos that run on their own when something happens, like Homeworks' automations and sequences." />
      <AutomationsPage />
    </>
  );
}
