import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/auth/logout (DESIGN.md §3.2). Clears the session cookie.
 * No session required — clearing an absent cookie is harmless.
 */
export async function POST() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
