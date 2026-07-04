import { NextResponse } from "next/server";
import { requireSession, UnauthorizedError } from "@/lib/session";
import {
  getGame,
  RoundExpiredError,
  AlreadyScoredError,
} from "@/lib/games/registry";
import { afterActivity } from "@/lib/progression";

/**
 * POST /api/game/answer (DESIGN.md §3.4, DESIGN_V1.md §4.2). Discriminated
 * body on optional `game_type` (absent → fallacy, preserving the MVP schema
 * exactly). Every game is validated + scored SERVER-side; the response merges
 * the per-game reveal with the additive gamification fields from afterActivity.
 *
 * Errors: 400 invalid body/unknown type · 404 round not found (fallacy) ·
 * 410 round_expired (bad/expired token) · 409 already_scored (round_uid replay).
 */
export async function POST(request: Request) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Discriminator: absent game_type → fallacy (legacy body). Unknown → 400.
  const rawType =
    json !== null && typeof json === "object"
      ? (json as Record<string, unknown>).game_type
      : undefined;
  if (rawType !== undefined && typeof rawType !== "string") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const game = getGame(rawType ?? "fallacy");
  if (!game) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const parsed = game.answerBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const outcome = await game.answer(parsed.data);
    if (!outcome) {
      return NextResponse.json({ error: "round not found" }, { status: 404 });
    }

    if (game.id !== "fallacy") {
      // Observability for the new seam (never log tokens/round contents).
      console.info(`[game/answer] type=${game.id} score=${outcome.score}`);
    }

    const activity = await afterActivity({
      pillar: "game",
      gameType: game.id,
      xpAwarded: outcome.xpAwarded,
      attemptFacts: outcome.reveal,
    });

    return NextResponse.json({
      ...outcome.reveal,
      streak: activity.streak,
      xp_awarded: activity.xpAwarded,
      xp_total: activity.xpTotal,
      level: activity.level,
      new_achievements: activity.newAchievements,
    });
  } catch (err) {
    if (err instanceof RoundExpiredError) {
      return NextResponse.json({ error: "round_expired" }, { status: 410 });
    }
    if (err instanceof AlreadyScoredError) {
      return NextResponse.json({ error: "already_scored" }, { status: 409 });
    }
    console.error(`[game/answer] type=${game.id}`, (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
