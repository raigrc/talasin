import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * Proxy (renamed middleware in Next 16) — CHEAP cookie-presence gate only
 * (DESIGN.md §4). It does NOT verify the HMAC; per Next 16 docs, proxy is not for
 * full auth. The authoritative check is `requireSession()` inside each Route
 * Handler and protected page.
 *
 * The matcher excludes the gate page, the login API, static assets, and metadata
 * files. Everything else redirects to /gate when the cookie is absent.
 */
export function proxy(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE);
  if (hasCookie) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything EXCEPT: the gate page, the auth API (login/logout must be
  // reachable unauthenticated), Next internals, and static/metadata files.
  matcher: [
    "/((?!gate|api/auth|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons|.*\\.png$).*)",
  ],
};
