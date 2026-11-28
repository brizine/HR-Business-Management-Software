"use client";
import { useAuth } from "@/lib/auth";
import { MapCodesEditor } from "@/components/map-codes";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageHead } from "@/components/ui";

/** Settings → Map Codes: the service area drawn as outlines, each with the code its properties get. */
export default function MapCodesPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Map Codes" sub="Your service area, drawn as outlines. A property takes the Map Code of the outline its pin is in." />
      <SettingsTabs />
      {can("manager", "customers") ? <MapCodesEditor /> : <p className="muted">Map Codes need Customers &amp; billing access.</p>}
    </>
  );
}
