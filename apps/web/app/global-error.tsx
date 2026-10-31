"use client";
import { ErrorScreen } from "@/components/error-screen";
import "./globals.css";

/** Catches errors in the root layout itself (where app/error.tsx can't). */
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
