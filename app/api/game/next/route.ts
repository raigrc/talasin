import { NextResponse } from "next/server";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getGame } from "@/lib/games/registry";

/**
 * GET /api/game/next?type=<fallacy|nback|syllogism> (DESIGN.md §3.3,
 * DESIGN_V1.md §4.1). One polymorphic route: `type` defaults to `fallacy` and
 * the fallacy response is byte-identical to the MVP contract. Rounds NEVER
 * include the answer key / ground truth (anti-cheat).
 */
export async function GET(request: Request) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type") ?? "fallacy";
  const game = getGame(type);
  if (!game) {
    return NextResponse.json({ error: "unknown game type" }, { status: 400 });
  }

  const excludeParam = searchParams.get("exclude") ?? "";
  const exclude = excludeParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const round = await game.next({ exclude });
    if (!round) {
      return NextResponse.json({ round: null, reason: "exhausted" });
    }
    return NextResponse.json({ round });
  } catch (err) {
    console.error(`[game/next] type=${game.id}`, (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
