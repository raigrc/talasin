import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/session";
import { optionalEnv } from "@/lib/env";
import { GeminiError } from "@/lib/gemini/config";
import { runTopup } from "@/lib/topup";

/**
 * GET /api/cron/topup (DEPLOY.md §5) — the weekly Vercel Cron entry point that
 * keeps the fallacy pool ahead of play. Registered in vercel.json
 * (`0 20 * * 0`).
 *
 * Auth: Vercel crons send `GET` with `Authorization: Bearer $CRON_SECRET` and no
 * cookie/custom headers, so this route is gated ONLY by that Bearer token
 * (constant-time compare via lib/session's safeEqual) — a separate, single
 * mechanism from the interactive POST route's session + admin-token gate, which
 * is left untouched.
 *
 * Fails CLOSED: if CRON_SECRET is unset the route returns 500 and never runs the
 * (Gemini-spending) top-up — it must never execute unauthenticated.
 */

// A 20-round Gemini batch + self-critique pass is well under 60s, but give the
// function headroom (per DEPLOY.md §5). Vercel reads this from the build output.
export const maxDuration = 60;

export async function GET(request: Request) {
  // 1) Fail closed when the cron secret isn't configured — never run unauthed.
  const cronSecret = optionalEnv("CRON_SECRET");
  if (!cronSecret) {
    console.error("[cron/topup] CRON_SECRET is not set — refusing to run.");
    return NextResponse.json({ error: "cron_not_configured" }, { status: 500 });
  }

  // 2) Bearer-token gate. Vercel sends `Authorization: Bearer <CRON_SECRET>`.
  //    safeEqual hashes both sides to fixed-width digests before timingSafeEqual,
  //    so neither a missing header nor a length mismatch leaks via timing.
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (!safeEqual(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 3) Run the shared top-up (same generate → dedup → insert as the POST route).
  try {
    const result = await runTopup();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GeminiError) {
      // Map typed errors to HTTP status without string-matching (config.ts).
      const status = err.kind === "rate_limited" ? 429 : err.kind === "no_api_key" ? 500 : 502;
      const code = err.kind === "rate_limited" ? "gemini_rate_limited" : "gemini_failed";
      console.error(`[cron/topup] gemini ${err.kind}: ${err.detail ?? err.message}`);
      // Return only the stable error code — never leak err.detail/message.
      return NextResponse.json({ error: code }, { status });
    }
    console.error("[cron/topup]", (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
