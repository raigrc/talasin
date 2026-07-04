import { NextResponse } from "next/server";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getStats } from "@/lib/stats";

/**
 * GET /api/stats (DESIGN.md §3.7) — dashboard aggregates. The /progress page reads
 * getStats() directly in the RSC (no network hop); this handler is the
 * client-side refresh fallback. Session-gated, dynamic (reads cookies + DB).
 */
export async function GET() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  try {
    const stats = await getStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("[api/stats]", (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
