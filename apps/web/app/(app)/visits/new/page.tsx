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
  const [preset, setPreset] = useState<Parameters<typeof VisitForm>[0]["preset"] | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    // From an accepted estimate: its customer, address, title and the lines the customer chose (per visit).
    const estimateId = url.searchParams.get("estimateId");
    if (estimateId) {
      api<any>(`/estimates/${estimateId}`).then((e) => setPreset({
        customer: { id: e.customer.id, name: e.customer.name }, propertyId: e.propertyId ?? e.lines.find((l: any) => l.propertyId)?.propertyId ?? undefined,
        title: e.title || `Estimate ${e.number}`, estimateId: e.id,
        notes: e.lines.some((l: any) => l.included && l.visits > 1) ? `From estimate ${e.number}: ${e.lines.filter((l: any) => l.included && l.visits > 1).map((l: any) => `${l.description} × ${l.visits} visits`).join("; ")}. Set it to repeat below.` : undefined,
        lines: e.lines.filter((l: any) => l.included).map((l: any) => ({ serviceTypeId: l.serviceTypeId, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxRate: l.taxRate, budgetedHours: l.budgetedHours, lawnArea: l.lawnArea, lawnAreaSqFt: l.lawnAreaSqFt })),
      }), () => setPreset({}));
      return;
    }
    const customerId = url.searchParams.get("customerId");
    const propertyId = url.searchParams.get("propertyId") ?? undefined;
    const date = url.searchParams.get("date") ?? undefined;
    const notes = url.searchParams.get("notes")?.slice(0, 2000) || undefined;
    const done = (customer?: { id: string; name: string }) => setPreset({ customer, propertyId: customer ? propertyId : undefined, date, notes });
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
