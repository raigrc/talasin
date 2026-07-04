"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Top nav across the three pillars. Client component (needs the active-path
 * highlight). Logout posts to /api/auth/logout then hard-navigates to /gate.
 */
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/game", label: "Game" },
  { href: "/interview", label: "Interview" },
  { href: "/progress", label: "Progress" },
] as const;

export function Nav() {
  const pathname = usePathname();

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/gate";
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color:var(--background)]/80 backdrop-blur">
      <nav className="mx-auto flex max-w-3xl items-center gap-1 px-4 py-3">
        <Link href="/" className="mr-2 font-mono text-sm font-semibold tracking-tight text-[var(--accent)]">
          talasin
        </Link>
        <div className="flex flex-1 items-center gap-1">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-[var(--surface-2)] text-[var(--foreground)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <button
          onClick={logout}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--danger)]"
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
