import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getNextRound } from "@/lib/game";
import { Nav } from "@/app/Nav";
import { GameClient } from "./GameClient";

/**
 * /game/fallacy — server shell (DESIGN.md §1; moved from /game in DESIGN_V1.md
 * §6). Requires a session, loads the first round server-side (correct answer
 * NOT included), then the client drives play.
 */
export default async function FallacyGamePage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let initialRound = null;
  let loadError = false;
  try {
    initialRound = await getNextRound([]);
  } catch (err) {
    console.error("[game/fallacy/page]", (err as Error)?.message);
    loadError = true;
  }

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold">Spot the fallacy</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Read the argument. Which logical fallacy does it commit?
        </p>
        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load rounds. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          <GameClient initialRound={initialRound} />
        )}
      </main>
    </div>
  );
}
