"use client";
import { PageHead } from "@/components/ui";
import { TextInbox } from "@/components/texting";

/** Texts with customers, newest conversation first. */
export default function Texts() {
  return (
    <>
      <PageHead title="Texts" sub="Every conversation with customers by text, newest first. Open one to read and reply on the customer's page." />
      <TextInbox />
    </>
  );
}
