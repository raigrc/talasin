import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, UnauthorizedError, safeEqual } from "@/lib/session";
import { optionalEnv } from "@/lib/env";
import { GeminiError } from "@/lib/gemini/config";
import { FALLACY_KEYS, type FallacyKey } from "@/lib/gemini/schemas";
import { runTopup } from "@/lib/topup";

/**
 * POST /api/game/topup (DESIGN.md §3.5) — the quota-saving batch generator.
 * Auth: valid session PLUS the `x-talasin-admin` header == TALASIN_ADMIN_TOKEN.
 * Generation/dedup/insert live in the shared lib/topup helper (reused by the
 * weekly cron route); this handler owns only the interactive auth + body shape.
 */

const bodySchema = z.object({
  count: z.number().int().min(1).max(50).optional(),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  fallacy_keys: z.array(z.enum(FALLACY_KEYS)).optional(),
});

export async function POST(request: Request) {
  // 1) Session.
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  // 2) Admin token.
  const adminToken = optionalEnv("TALASIN_ADMIN_TOKEN");
  // safeEqual hashes both sides to equal-length digests before timingSafeEqual,
  // so a length mismatch can't leak via timing (unlike an early-return compare).
  const provided = request.headers.get("x-talasin-admin") ?? "";
  if (!adminToken || !safeEqual(provided, adminToken)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 3) Body.
  let json: unknown = {};
  try {
    const text = await request.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const count = parsed.data.count ?? 20;

  try {
    const result = await runTopup(count, {
      difficulty: parsed.data.difficulty,
      fallacyKeys: parsed.data.fallacy_keys as FallacyKey[] | undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GeminiError) {
      const status = err.kind === "rate_limited" ? 429 : err.kind === "no_api_key" ? 500 : 502;
      const code =
        err.kind === "rate_limited" ? "gemini_rate_limited"
        : err.kind === "no_api_key" ? "no_api_key" // mirrors /api/interview/feedback; TopupPanel maps it
        : "gemini_failed";
      console.error(`[game/topup] gemini ${err.kind}: ${err.detail ?? err.message}`);
      // Return only the stable error code — never leak err.message to the client.
      return NextResponse.json({ error: code }, { status });
    }
    console.error("[game/topup]", (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
