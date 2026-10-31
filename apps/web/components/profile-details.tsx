"use client";
import { PROFILE_FIELDS, ageOn, type ProfileFieldKey } from "@crewdesk/shared";
import { fmtDate, money } from "@/lib/api";
import { Badge } from "./ui";

const LABELS = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f.label])) as Record<ProfileFieldKey, string>;

/** One detail's value, or null when this viewer can't see it (or it doesn't apply). */
function value(key: ProfileFieldKey, e: any) {
  switch (key) {
    case "email": return e.email;
    case "phone": return e.phone ?? "—";
    case "role": return e.role;
    case "hireDate": return fmtDate(e.startDate);
    case "pay": return "payRateCents" in e ? `${money(e.payRateCents)} ${e.payType === "hourly" ? "/hr" : "/yr"}` : null;
    case "employment": return e.employmentType?.replace("_", " ");
    case "login": return e.hasLogin ? "Yes" : "Not set";
    case "twoFactor": return "twoFactorEnabled" in e ? (e.twoFactorEnabled ? "On" : "Off") : null;
    case "signIn": return e.locked ? <Badge value="locked" /> : null;
    case "dateOfBirth": return "dateOfBirth" in e ? (e.dateOfBirth ? `${fmtDate(e.dateOfBirth)} (age ${ageOn(e.dateOfBirth)})` : "—") : null;
    case "address": {
      if (!("addressLine1" in e)) return null;
      const street = [e.addressLine1, e.addressLine2].filter(Boolean).join(", ");
      const cityLine = [e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return street || cityLine ? <>{street}{street && cityLine && <br />}{cityLine}</> : "—";
    }
    case "emergency":
      if (!("emergencyName" in e)) return null;
      return e.emergencyName || e.emergencyPhone ? (
        <>
          {e.emergencyName ?? ""}{e.emergencyRelationship ? ` (${e.emergencyRelationship})` : ""}
          {e.emergencyPhone && <div><a href={`tel:${e.emergencyPhone}`}>{e.emergencyPhone}</a></div>}
        </>
      ) : "—";
  }
}

/** The employee's details, in the company's order (the owner sets it in Settings → Company). */
export function ProfileDetails({ e, order }: { e: any; order: ProfileFieldKey[] }) {
  return (
    <div className="formgrid">
      {order.map((key) => {
        const v = value(key, e);
        return v === null || v === undefined ? null : <div key={key}><div className="muted">{LABELS[key]}</div>{v}</div>;
      })}
    </div>
  );
}
