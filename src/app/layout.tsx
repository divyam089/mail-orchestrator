import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const themeBoot = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q==="dark"||q==="light"?q:localStorage.getItem("theme");if(t==="dark")document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");}catch(e){}})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Figcel Outreach",
  description: "Cold email ledger for 15 Google Workspace inboxes. Sending is off.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        {children}
      </body>
    </html>
  );
}
