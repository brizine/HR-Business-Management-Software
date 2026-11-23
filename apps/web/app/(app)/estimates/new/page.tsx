"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { customerName } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { PageHead } from "@/components/ui";
import { EstimateForm } from "@/components/estimates";

/** A new estimate; from a customer's page it starts with them. */
export default function NewEstimate() {
  const router = useRouter();
  const [preset, setPreset] = useState<{ customer?: { id: string; name: string } } | null>(null);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("customerId");
    if (id) api<any>(`/customers/${id}`).then((c) => setPreset({ customer: { id: c.id, name: customerName(c) } }), () => setPreset({}));
    else setPreset({});
  }, []);
  return (
    <>
      <PageHead title="New estimate" before={<Link className="btn" href="/estimates" aria-label="Back to estimates">←</Link>} />
      {preset && <EstimateForm preset={preset} onCancel={() => router.back()} onSaved={(e) => router.push(`/estimates/${e.id}`)} />}
    </>
  );
}
