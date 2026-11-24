import { redirect } from "next/navigation";

/** Products moved into Chemical Tracking. */
export default function ProductsMoved() {
  redirect("/chemical-tracking/products");
}
