"use client";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { CourseForm } from "@/components/training";

export default function NewCourse() {
  return (
    <>
      <PageHead title="New course" sub="Set it up, then add lessons. It stays a draft (only you see it) until you publish it.">
        <Link className="btn" href="/training">Back to training</Link>
      </PageHead>
      <CourseForm />
    </>
  );
}
