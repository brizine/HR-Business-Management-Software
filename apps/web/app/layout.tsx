import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { MenusProvider } from "@/lib/menus";
import "./globals.css";

export const metadata: Metadata = { title: "Crewdesk", description: "HR and fleet maintenance for small businesses" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider><MenusProvider>{children}</MenusProvider></AuthProvider>
      </body>
    </html>
  );
}
