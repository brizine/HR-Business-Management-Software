import { redirect } from "next/navigation";

/** Weather moved into Chemical Tracking. */
export default function WeatherMoved() {
  redirect("/chemical-tracking/weather");
}
