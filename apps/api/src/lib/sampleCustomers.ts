import { eq } from "drizzle-orm";
import { lawnTotal, type TagColor } from "@crewdesk/shared";
import { crmTags, customerContacts, customers, properties } from "../db/schema";
import { assignCustomer, nextCustomerNumber, recordTagChanges, type Tx } from "./crm";

/**
 * Ten sample accounts (plus two tenants) for testing the customer system, each covering one tricky
 * case. Names and addresses are made up; emails use example.com and phones the 555-01xx range, so
 * nothing ever reaches a real person.
 */
type SampleProperty = {
  name?: string; street: string; city: string; zip: string; lat: number; lng: number; mapCode?: string;
  frontSqFt?: number; backSqFt?: number; lawnSqFt?: number; gateCode?: string; pets?: string; accessNotes?: string; notes?: string;
  tags?: string[]; residentKey?: string;
};
type SampleCustomer = {
  key: string; kind: "residential" | "commercial" | "hoa"; firstName?: string; lastName?: string; companyName?: string;
  email?: string; phone?: string; billingStreet?: string; billingCity?: string; billingZip?: string;
  delivery: ("email" | "paper" | "text")[]; source?: string; poRequired?: boolean; notes?: string; status?: "active" | "lead"; tags?: string[];
  contacts?: { name: string; relation?: string; email?: string; phone?: string; getsInvoices: boolean }[];
  properties?: SampleProperty[];
};

export const SAMPLE_CUSTOMERS: SampleCustomer[] = [
  {
    key: "email", kind: "residential", firstName: "Jane", lastName: "Example", email: "jane.example@example.com", phone: "(405) 555-0101",
    billingStreet: "1201 Bluestem Dr", billingCity: "Norman", billingZip: "73069", delivery: ["email"], source: "Google map",
    notes: "Sample: homeowner who gets invoices by email.",
    properties: [{ street: "1201 Bluestem Dr", city: "Norman", zip: "73069", lat: 35.2251, lng: -97.4689, mapCode: "801", frontSqFt: 4200, backSqFt: 6800 }],
  },
  {
    key: "paper", kind: "residential", firstName: "Harold", lastName: "Fields", phone: "(405) 555-0102",
    billingStreet: "418 Sooner Ct", billingCity: "Norman", billingZip: "73071", delivery: ["paper"], source: "Door hanger",
    notes: "Sample: no email, so invoices are printed and mailed.",
    properties: [{ street: "418 Sooner Ct", city: "Norman", zip: "73071", lat: 35.2032, lng: -97.4121, mapCode: "802", frontSqFt: 3100, backSqFt: 5400, pets: "Small dog, usually inside", tags: ["Dog in yard"] }],
  },
  // Tenants first, so the landlord's rentals can name them as residents.
  {
    key: "tenant1", kind: "residential", firstName: "Tara", lastName: "Tenant", email: "tara.tenant@example.com", phone: "(405) 555-0103",
    delivery: ["text"], notes: "Sample: tenant at 215 Elm; gets reminders, not invoices.",
  },
  {
    key: "tenant2", kind: "residential", firstName: "Ray", lastName: "Renter", email: "ray.renter@example.com", phone: "(405) 555-0104",
    delivery: ["email"], notes: "Sample: tenant at 217 Elm.",
  },
  {
    key: "landlord", kind: "commercial", firstName: "Sam", lastName: "Lee", companyName: "Lee Rentals LLC", email: "sam@leerentals.example.com", phone: "(405) 555-0105",
    billingStreet: "PO Box 1201", billingCity: "Norman", billingZip: "73070", delivery: ["email"], source: "Referral", tags: ["Commercial"],
    notes: "Sample: landlord with two rentals, each with a tenant.",
    properties: [
      { name: "Rental A", street: "215 Elm St", city: "Norman", zip: "73069", lat: 35.2189, lng: -97.4452, mapCode: "801", frontSqFt: 2600, backSqFt: 3900, residentKey: "tenant1" },
      { name: "Rental B", street: "217 Elm St", city: "Norman", zip: "73069", lat: 35.2187, lng: -97.4452, mapCode: "801", frontSqFt: 2500, backSqFt: 4100, residentKey: "tenant2", tags: ["Gate code needed"], gateCode: "1357" },
    ],
  },
  {
    key: "manager", kind: "commercial", companyName: "Prairie Property Management", firstName: "Dana", lastName: "Brooks", email: "dana@prairiepm.example.com", phone: "(405) 555-0106",
    billingStreet: "2200 W Main St, Suite 4", billingCity: "Norman", billingZip: "73069", delivery: ["email"], source: "Website", tags: ["Commercial"],
    notes: "Sample: property manager with several houses; accounts payable gets a copy of invoices.",
    contacts: [{ name: "Accounts Payable", relation: "Accounts payable", email: "ap@prairiepm.example.com", getsInvoices: true }],
    properties: [
      { street: "3305 Cedar Ln", city: "Norman", zip: "73072", lat: 35.2368, lng: -97.4891, mapCode: "803", frontSqFt: 3800, backSqFt: 5200 },
      { street: "3311 Cedar Ln", city: "Norman", zip: "73072", lat: 35.2368, lng: -97.4899, mapCode: "803", frontSqFt: 3600, backSqFt: 5000 },
      { street: "1408 Willow Bend", city: "Moore", zip: "73160", lat: 35.3271, lng: -97.4756, mapCode: "811", frontSqFt: 4100, backSqFt: 6100, accessNotes: "Lockbox on the side gate; call Dana if it's locked." },
    ],
  },
  {
    key: "commercial", kind: "commercial", companyName: "Norman Office Park", firstName: "Chris", lastName: "Allen", email: "facilities@officepark.example.com", phone: "(405) 555-0107",
    billingStreet: "3500 Commerce Pkwy", billingCity: "Norman", billingZip: "73072", delivery: ["email", "paper"], poRequired: true, source: "Google search", tags: ["Commercial"],
    notes: "Sample: commercial account that needs a PO number on every invoice.",
    properties: [{ name: "Office park grounds", street: "3500 Commerce Pkwy", city: "Norman", zip: "73072", lat: 35.2442, lng: -97.4968, mapCode: "803", lawnSqFt: 42000, accessNotes: "Treat before 7 am or after 6 pm on weekdays." }],
  },
  {
    key: "hoa", kind: "hoa", companyName: "Brookhaven Commons HOA", firstName: "Pat", lastName: "Morgan", email: "board@brookhavenhoa.example.com", phone: "(405) 555-0108",
    billingStreet: "PO Box 720", billingCity: "Norman", billingZip: "73070", delivery: ["email"], source: "Referral", tags: ["HOA"],
    notes: "Sample: HOA with entrance and common areas.",
    properties: [{ name: "Entrance and common areas", street: "100 Brookhaven Blvd", city: "Norman", zip: "73072", lat: 35.2402, lng: -97.4785, mapCode: "803", lawnSqFt: 25000 }],
  },
  {
    key: "twoprops", kind: "residential", firstName: "Maria", lastName: "Gonzalez", email: "maria.gonzalez@example.com", phone: "(405) 555-0109",
    billingStreet: "905 Lindsey St", billingCity: "Norman", billingZip: "73069", delivery: ["email", "text"], source: "Facebook",
    notes: "Sample: two properties, each to be paid with a different card (cards come in Phase 2).",
    properties: [
      { name: "Home", street: "905 Lindsey St", city: "Norman", zip: "73069", lat: 35.2105, lng: -97.4501, mapCode: "802", frontSqFt: 3300, backSqFt: 4700 },
      { name: "Mom's house", street: "2716 Oakwood Dr", city: "Norman", zip: "73071", lat: 35.1998, lng: -97.4013, mapCode: "802", frontSqFt: 2900, backSqFt: 4300 },
    ],
  },
  {
    key: "exempt", kind: "residential", firstName: "Robert", lastName: "Senior", phone: "(405) 555-0110",
    billingStreet: "612 Classen Blvd", billingCity: "Norman", billingZip: "73071", delivery: ["paper"], source: "Repeat customer",
    notes: "Sample: long-time customer exempt from the card-on-file rule (pays by check).",
    properties: [{ street: "612 Classen Blvd", city: "Norman", zip: "73071", lat: 35.2071, lng: -97.4373, mapCode: "802", frontSqFt: 3500, backSqFt: 5100 }],
  },
  {
    key: "prepay", kind: "residential", firstName: "Lisa", lastName: "Prepay", email: "lisa.prepay@example.com", phone: "(405) 555-0111",
    billingStreet: "4420 Hidden Hill Rd", billingCity: "Norman", billingZip: "73072", delivery: ["email"], source: "Yard sign", tags: ["Prepay"],
    notes: "Sample: prepays the season for a discount (prepay comes in Phase 2).",
    properties: [{ street: "4420 Hidden Hill Rd", city: "Norman", zip: "73072", lat: 35.2511, lng: -97.5032, mapCode: "804", frontSqFt: 5200, backSqFt: 8900, gateCode: "2468", tags: ["Gate code needed"] }],
  },
  {
    key: "outside", kind: "residential", firstName: "Pat", lastName: "Faraway", email: "pat.faraway@example.com", phone: "(405) 555-0112",
    billingStreet: "18200 County Line Rd", billingCity: "Blanchard", billingZip: "73010", delivery: ["email"], source: "Website", status: "lead", tags: ["Outside service area"],
    notes: "Sample: lead whose property is just outside the service area (no Map Code).",
    properties: [{ street: "18200 County Line Rd", city: "Blanchard", zip: "73010", lat: 35.1371, lng: -97.6583, lawnSqFt: 15000, tags: ["Outside service area"] }],
  },
];

/** Finds or makes the company's tags by name (case doesn't matter). */
async function tagsByName(tx: Tx, companyId: string, wanted: Record<string, TagColor>) {
  const existing = await tx.select().from(crmTags).where(eq(crmTags.companyId, companyId));
  const out: Record<string, string> = {};
  for (const [name, color] of Object.entries(wanted)) {
    const hit = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
    out[name] = hit ? hit.id : (await tx.insert(crmTags).values({ companyId, name, color }).returning())[0].id;
  }
  return out;
}

/** Adds the sample customers (in a transaction); returns how many customers were made. */
export async function addSamples(tx: Tx, companyId: string, byId: string, today: string) {
  const tags = await tagsByName(tx, companyId, { Sample: "gray", Commercial: "blue", HOA: "purple", "Dog in yard": "orange", "Gate code needed": "yellow", Prepay: "green", "Outside service area": "red" });
  const tagged = (names: string[] = []) => ["Sample", ...names].map((n) => tags[n]);
  const ids: Record<string, string> = {};
  let count = 0;
  for (const s of SAMPLE_CUSTOMERS) {
    const number = await nextCustomerNumber(tx, companyId);
    const { key, tags: ctags, contacts, properties: props, ...c } = s;
    const [row] = await tx.insert(customers).values({ ...c, companyId, number, sample: true, tagIds: tagged(ctags), createdById: byId }).returning();
    await recordTagChanges(tx, { companyId, before: [], after: row.tagIds, customerId: row.id, source: "sample", byId });
    ids[key] = row.id;
    count++;
    if (contacts?.length) await tx.insert(customerContacts).values(contacts.map((k, i) => ({ ...k, companyId, customerId: row.id, sortOrder: i })));
    for (const p of props ?? []) {
      const { residentKey, tags: ptags, ...pv } = p;
      const [prop] = await tx.insert(properties).values({ ...pv, lawnSqFt: lawnTotal(pv), companyId, sample: true, tagIds: tagged(ptags), createdById: byId }).returning();
      await recordTagChanges(tx, { companyId, before: [], after: prop.tagIds, propertyId: prop.id, source: "sample", byId });
      await assignCustomer(tx, { companyId, propertyId: prop.id, customerId: row.id, role: "bill_to", startDate: today });
      if (residentKey) {
        // Tenants are their own customers, on the property as residents.
        const r = SAMPLE_CUSTOMERS.find((x) => x.key === residentKey)!;
        const rid = ids[residentKey];
        if (!rid) throw new Error(`Sample resident ${r.key} must come before the property that uses it`);
        await assignCustomer(tx, { companyId, propertyId: prop.id, customerId: rid, role: "resident", startDate: today });
      }
    }
  }
  return count;
}

