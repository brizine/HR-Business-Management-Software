import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { MenusProvider } from "@/lib/menus";
import { THEME_BOOT } from "@/lib/theme-boot";
import "./globals.css";
import "./dispatch.css";

export const metadata: Metadata = { title: "Crewdesk", description: "HR and fleet maintenance for small businesses" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-theme on <html> before React loads, so React mustn't complain about it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <AuthProvider><MenusProvider>{children}</MenusProvider></AuthProvider>
      </body>
    </html>
  );
}
