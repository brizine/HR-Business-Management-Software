"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { me, ready, can } = useAuth();
  const router = useRouter();
  useEffect(() => {
    // The dashboard is for managers; everyone else starts on their schedule.
    if (ready) router.replace(!me ? "/login" : can("manager") ? "/dashboard" : "/schedule");
  }, [me, ready, router, can]);
  return null;
}
