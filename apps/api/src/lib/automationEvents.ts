import { db } from "../db";
import { automationEvents } from "../db/schema";

export type AutomationEventKind = "card_removed" | "bank_removed" | "receipt_sent" | "payment_declined";

/**
 * Notes something automations can start on that leaves no other trace (a card or bank account
 * removed, a receipt sent, a payment declined). Never throws: a missed note mustn't break the
 * payment or receipt it's about.
 */
export async function recordAutomationEvent(companyId: string, customerId: string | null, kind: AutomationEventKind, subject?: { type: "invoice" | "payment"; id: string }) {
  try {
    await db.insert(automationEvents).values({ companyId, customerId, kind, subjectType: subject?.type ?? null, subjectId: subject?.id ?? null });
  } catch (e) {
    console.error("Recording an automation event failed:", (e as Error).message);
  }
}
