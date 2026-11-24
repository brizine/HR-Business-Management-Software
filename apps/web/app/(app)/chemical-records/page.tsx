import { redirect } from "next/navigation";

/** Chemical records moved into Chemical Tracking. */
export default function ChemicalRecordsMoved() {
  redirect("/chemical-tracking");
}
