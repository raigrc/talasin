"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation across the three pillars.
 *
 * Desktop (sm+): links live in the sticky header row.
 * Mobile (<sm): links move to a fixed bottom tab bar (thumb-friendly PWA
 * pattern); the header keeps only the logo + logout so nothing gets crushed
 * on narrow screens. globals.css pads <main> on mobile so page content never
 * hides behind the fixed bar.
 *
 * Logout posts to /api/auth/logout then hard-navigates to /gate.
 */
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/game", label: "Game" },
  { href: "/interview", label: "Interview" },
  { href: "/progress", label: "Progress" },
] as const;

function TabIcon({ href, active }: { href: string; active: boolean }) {
  const stroke = active ? "var(--accent)" : "var(--muted)";
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (href) {
    case "/":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
        </svg>
      );
    case "/game":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "/interview":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </svg>
      );
    case "/progress":
      return (
        <svg {...common}>
          <path d="M4 20V10" />
          <path d="M10 20V4" />
          <path d="M16 20v-8" />
          <path d="M22 20H2" />
        </svg>
      );
    default:
      return null;
  }
}

export function Nav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/gate";
    }
  }

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color:var(--background)]/80 backdrop-blur">
        <nav className="mx-auto flex max-w-3xl items-center gap-1 px-4 py-3">
          <Link
            href="/"
            className="mr-2 shrink-0 font-mono text-sm font-semibold tracking-tight text-[var(--accent)]"
          >
            talasin
          </Link>
          {/* Desktop links — hidden on mobile (bottom tab bar takes over) */}
          <div className="hidden flex-1 items-center gap-1 sm:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  isActive(l.href)
                    ? "bg-[var(--surface-2)] text-[var(--foreground)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </div>
          <div className="flex-1 sm:hidden" />
          <button
            onClick={logout}
            className="shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--danger)]"
          >
            Log out
          </button>
        </nav>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[color:var(--background)]/90 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto grid max-w-3xl grid-cols-4">
          {LINKS.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className="flex flex-col items-center gap-0.5 py-2"
              >
                <TabIcon href={l.href} active={active} />
                <span
                  className={`text-[10px] leading-tight ${
                    active
                      ? "font-medium text-[var(--accent)]"
                      : "text-[var(--muted)]"
                  }`}
                >
                  {l.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
