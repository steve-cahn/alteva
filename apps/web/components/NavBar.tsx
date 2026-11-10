"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "./Icons";

const LINKS = [
  { href: "/", label: "New crawl" },
  { href: "/history", label: "History" },
];

/** The header. `active` is the current path; the Suspense fallback in the layout renders it without one. */
export function NavBarView({ active }: { active: string | null }) {
  const isActive = (href: string) => (href === "/" ? active === "/" : active?.startsWith(href) === true);
  return (
    <header className="sticky top-0 z-20 border-b border-line/80 bg-bg/80 backdrop-blur-xl">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5 rounded-lg">
          <LogoMark size={30} />
          <span className="text-[15px] font-semibold tracking-tight">Web Crawler</span>
        </Link>
        <ul className="flex items-center gap-1">
          {LINKS.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
                className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  isActive(href) ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

export function NavBar() {
  return <NavBarView active={usePathname()} />;
}
