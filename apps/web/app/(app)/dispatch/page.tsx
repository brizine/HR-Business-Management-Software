"use client";
import { PlanDispatch } from "@/components/dispatch/plan";

/** Schedule → Dispatch: the dispatch board from the Crewdesk plan (a lane per crew, with a map). */
export default function DispatchPage() {
  return <PlanDispatch />;
}
