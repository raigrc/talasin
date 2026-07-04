import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  verifyPassphrase,
  issueSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/session";
import { checkLoginAllowed, recordLoginAttempt } from "@/lib/loginLimiter";

/**
 * POST /api/auth/login (DESIGN.md §3.1, DESIGN_V1.md §4.6)
 * Body: { passphrase }. On success, sets the signed httpOnly session cookie.
 * Constant-time compare, generic 401. Rate limiting is durable across
 * serverless lambdas via the login_attempts table (lib/loginLimiter.ts):
 * 10 fails / 15 min per IP, checked BEFORE scrypt runs; fails OPEN on a
 * Supabase outage (the passphrase is the real gate — stated trade-off §7).
 */

const bodySchema = z.object({ passphrase: z.string().min(1).max(512) });

function clientIp(req: Request): string {
  // Trusting x-forwarded-for is safe ONLY on Vercel, where the platform
  // overwrites it at the edge. On any other host (or bare local dev) it is
  // spoofable, and header-less requests all share the "unknown" bucket —
  // acceptable because brute-force protection ultimately rests on the
  // scrypt+pepper passphrase (DESIGN_V1 §7); re-derive the IP from the
  // platform's trusted source if this app ever moves off Vercel.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!(await checkLoginAllowed(ip))) {
    return NextResponse.json(
      { error: "too many attempts, try again shortly", code: "rate_limited" },
      { status: 429 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "passphrase required" }, { status: 400 });
  }

  let ok = false;
  try {
    ok = verifyPassphrase(parsed.data.passphrase);
  } catch (err) {
    // Missing TALASIN_PASSPHRASE_HASH etc. — config error, not a client error.
    console.error("[auth] login config error:", (err as Error)?.message);
    return NextResponse.json(
      { error: "server not configured", code: "config" },
      { status: 500 },
    );
  }

  // Record the verified outcome (durable window counter). Best-effort inside.
  await recordLoginAttempt(ip, ok);

  if (!ok) {
    return NextResponse.json({ error: "invalid passphrase" }, { status: 401 });
  }

  // Success: issue the signed cookie.
  const token = issueSessionToken();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions());

  return NextResponse.json({ ok: true });
}
