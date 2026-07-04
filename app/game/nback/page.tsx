import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { GAMES } from "@/lib/games/registry";
import { Nav } from "@/app/Nav";
import { NBackClient, type NBackRound } from "./NBackClient";

/**
 * /game/nback — RSC shell (DESIGN_V1.md §6). Requires a session and fetches
 * the first server-seeded round (trials + signed token; ground truth stays
 * server-side, re-derived from the token at answer time).
 */
export default async function NBackPage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let initialRound: NBackRound | null = null;
  let loadError = false;
  try {
    initialRound = (await GAMES.nback.next({ exclude: [] })) as NBackRound | null;
  } catch (err) {
    console.error("[game/nback/page]", (err as Error)?.message);
    loadError = true;
  }

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold">Dual N-back</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Track positions and letters N steps back. Working-memory training.
        </p>
        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load a session. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          <NBackClient initialRound={initialRound} />
        )}
      </main>
    </div>
  );
}
