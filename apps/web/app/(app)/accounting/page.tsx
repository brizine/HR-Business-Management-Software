"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Accounting moved to Settings → Integrations; old links land there. */
export default function Accounting() {
  const router = useRouter();
  useEffect(() => { router.replace("/settings/integrations"); }, [router]);
  return null;
}
