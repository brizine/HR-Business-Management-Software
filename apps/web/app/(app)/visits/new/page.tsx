"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { customerName } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { VisitForm } from "@/components/visits";

/** A new work order; from a customer or property page (or a calendar day) it starts filled in. */
export default function NewWorkOrder() {
  const router = useRouter();
  const { can } = useAuth();
  const [preset, setPreset] = useState<{ customer?: { id: string; name: string }; propertyId?: string; date?: string } | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const customerId = url.searchParams.get("customerId");
    const propertyId = url.searchParams.get("propertyId") ?? undefined;
    const date = url.searchParams.get("date") ?? undefined;
    const done = (customer?: { id: string; name: string }) => setPreset({ customer, propertyId: customer ? propertyId : undefined, date });
    if (customerId) api<any>(`/customers/${customerId}`).then((c) => done({ id: c.id, name: customerName(c) }), () => done());
    else if (propertyId) {
      // From a property page: its bill-to customer.
      api<any>(`/properties/${propertyId}`).then((p) => {
        const who = p.assignments?.find((a: any) => !a.endDate && a.role === "bill_to") ?? p.assignments?.find((a: any) => !a.endDate);
        done(who ? { id: who.customerId, name: who.name } : undefined);
      }, () => done());
    } else done();
  }, []);
  if (!can("manager", "customers")) return <><PageHead title="New work order" /><p className="muted">Scheduling work orders needs Customers &amp; billing access.</p></>;
  return (
    <>
      <PageHead title="New work order" before={<Link className="btn" href="/visits" aria-label="Back to work orders">←</Link>} />
      {preset && <VisitForm preset={preset} onCancel={() => router.back()} onSaved={(v) => router.push(`/visits/${v.id}`)} />}
    </>
  );
}
