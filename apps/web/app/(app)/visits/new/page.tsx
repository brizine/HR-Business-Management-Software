"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WORK_ORDER_TYPES, WORK_ORDER_TYPE_HINTS, WORK_ORDER_TYPE_LABELS, customerName, isWorkOrderType, type WorkOrderType } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { PackageWorkOrder } from "@/components/packages";
import { VisitForm } from "@/components/visits";

type Preset = NonNullable<Parameters<typeof VisitForm>[0]["preset"]>;

/**
 * A new work order. It asks the type first (waiting list, package, one time or recurring), then shows that
 * type's form; from a customer or property page (or a calendar day, or an accepted estimate) the form starts
 * filled in. `?type=` picks the type in the link.
 */
export default function NewWorkOrder() {
  const router = useRouter();
  const { can } = useAuth();
  const [preset, setPreset] = useState<Preset | null>(null);
  const [type, setType] = useState<WorkOrderType | null>(null);
  /** The property the link came from, for a package (which goes on a property whoever its customer is). */
  const [fromProperty, setFromProperty] = useState<string | undefined>();
  /** An estimate's lines make a work order, not a package. */
  const [fromEstimate, setFromEstimate] = useState(false);
  const [added, setAdded] = useState<{ name: string; property: { id: string; address: string }; created: number } | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get("type");
    // From an accepted estimate: its customer, address, title and the lines the customer chose (per visit).
    const estimateId = url.searchParams.get("estimateId");
    if (estimateId) {
      setFromEstimate(true);
      if (isWorkOrderType(asked) && asked !== "package") setType(asked);
      api<any>(`/estimates/${estimateId}`).then((e) => setPreset({
        customer: { id: e.customer.id, name: e.customer.name }, propertyId: e.propertyId ?? e.lines.find((l: any) => l.propertyId)?.propertyId ?? undefined,
        title: e.title || `Estimate ${e.number}`, estimateId: e.id,
        notes: e.lines.some((l: any) => l.included && l.visits > 1) ? `From estimate ${e.number}: ${e.lines.filter((l: any) => l.included && l.visits > 1).map((l: any) => `${l.description} × ${l.visits} visits`).join("; ")}. Pick Recurring Work Order to repeat it.` : undefined,
        lines: e.lines.filter((l: any) => l.included).map((l: any) => ({ serviceTypeId: l.serviceTypeId, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxRate: l.taxRate, budgetedHours: l.budgetedHours, lawnArea: l.lawnArea, lawnAreaSqFt: l.lawnAreaSqFt })),
      }), () => setPreset({}));
      return;
    }
    const customerId = url.searchParams.get("customerId");
    const propertyId = url.searchParams.get("propertyId") ?? undefined;
    const date = url.searchParams.get("date") ?? undefined;
    const notes = url.searchParams.get("notes")?.slice(0, 2000) || undefined;
    setFromProperty(propertyId);
    // The link said which type; a link for a day on the calendar means a job on that date.
    if (isWorkOrderType(asked)) setType(asked);
    else if (date) setType("single");
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
  const types = WORK_ORDER_TYPES.filter((t) => !(fromEstimate && t === "package"));
  return (
    <>
      <PageHead title="New work order" before={<Link className="btn" href="/visits" aria-label="Back to work orders">←</Link>} />
      {added ? (
        <div className="card stack">
          <p className="notice" role="status" style={{ margin: 0 }}>
            <strong>{added.name}</strong> added to {added.property.address}: {added.created} round{added.created === 1 ? "" : "s"} on the waiting list, each a work order.
          </p>
          <div className="row">
            <Link className="btn primary" href={`/properties/${added.property.id}`}>Open the property</Link>
            <Link className="btn" href="/waitlist">Open the waiting list</Link>
            <button type="button" className="btn" onClick={() => { setAdded(null); setType(null); }}>Add another work order</button>
          </div>
        </div>
      ) : preset && (
        <>
          <div className="card stack" style={{ gap: 8 }}>
            {type ? <span className="todo-label" id="wo-type-label">Type of work order</span> : <h2 id="wo-type-label" style={{ margin: 0 }}>What type of work order?</h2>}
            <div className={`wo-types${type ? " chosen" : ""}`} role="radiogroup" aria-labelledby="wo-type-label">
              {types.map((t) => (
                <button key={t} type="button" className="wo-type" role="radio" aria-checked={type === t} title={WORK_ORDER_TYPE_HINTS[t]} onClick={() => setType(t)}>
                  <strong>{WORK_ORDER_TYPE_LABELS[t]}</strong>
                  <span>{WORK_ORDER_TYPE_HINTS[t]}</span>
                </button>
              ))}
            </div>
            {!type && <div className="row"><button type="button" className="btn" onClick={() => router.back()}>Cancel</button></div>}
          </div>
          {type === "package"
            ? <PackageWorkOrder customer={preset.customer} propertyId={fromProperty} onCancel={() => router.back()} onDone={(e, created) => setAdded({ name: e.packageName, property: e.property, created })} />
            : type && <VisitForm type={type} preset={preset} onCancel={() => router.back()} onSaved={(v) => router.push(`/visits/${v.id}`)} />}
        </>
      )}
    </>
  );
}
