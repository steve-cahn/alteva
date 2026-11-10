import type { Metadata } from "next";
import { Suspense } from "react";
import { NavBar, NavBarView } from "@/components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Web Crawler",
  description: "Submit a crawl job, watch it run, and explore the pages it found.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col overflow-x-clip">
        {/* usePathname suspends on dynamic routes: the fallback is the same bar, minus the active highlight. */}
        <Suspense fallback={<NavBarView active={null} />}>
          <NavBar />
        </Suspense>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">{children}</main>
        <footer className="mx-auto w-full max-w-5xl px-4 pb-8 text-xs text-faint sm:px-6">
          Domain Link Ratio = links that stay on the site ÷ all links on the page.
        </footer>
      </body>
    </html>
  );
}
