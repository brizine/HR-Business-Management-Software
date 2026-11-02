import { useState } from "react";
import { Image } from "react-native";
import { API_URL, authHeaders } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** The company logo (Settings → Company info on the website), or nothing if there isn't one. */
export function CompanyLogo({ height = 28, maxWidth = 120 }: { height?: number; maxWidth?: number }) {
  const { me } = useAuth();
  const [broken, setBroken] = useState(false);
  if (!me?.company.hasLogo || broken) return null;
  const v = me.company.logoUpdatedAt ? `?v=${encodeURIComponent(me.company.logoUpdatedAt)}` : "";
  return (
    <Image
      source={{ uri: `${API_URL}/company/logo${v}`, headers: authHeaders() }}
      style={{ height, width: maxWidth }}
      resizeMode="contain"
      onError={() => setBroken(true)}
      accessibilityLabel={`${me.company.name} logo`}
    />
  );
}
