"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { me, ready } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (ready) router.replace(me ? "/dashboard" : "/login");
  }, [me, ready, router]);
  return null;
}
