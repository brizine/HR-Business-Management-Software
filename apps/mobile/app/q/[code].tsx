import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ErrorText, Screen, Txt } from "@/components/ui";

/**
 * Opens equipment from a label link (crewdesk://q/CODE, or https://…/q/CODE
 * once universal links are set up for your domain).
 */
export default function QrLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ id: string }>(`/assets/by-code/${encodeURIComponent(code)}`).then(
      (a) => router.replace(`/asset/${a.id}`),
      (e) => setError((e as Error).message),
    );
  }, [code]);
  return <Screen>{error ? <ErrorText error={error} /> : <Txt muted>Opening equipment…</Txt>}</Screen>;
}
