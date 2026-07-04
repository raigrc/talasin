import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { GAMES } from "@/lib/games/registry";
import { Nav } from "@/app/Nav";
import { SyllogismClient, type SyllogismRound } from "./SyllogismClient";

/**
 * /game/syllogism — RSC shell (DESIGN_V1.md §6). Requires a session and
 * fetches the first template-bank round server-side. Validity never ships
 * with the round — it travels only inside the signed token.
 */
export default async function SyllogismPage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let initialRound: SyllogismRound | null = null;
  let loadError = false;
  try {
    initialRound = (await GAMES.syllogism.next({ exclude: [] })) as SyllogismRound | null;
  } catch (err) {
    console.error("[game/syllogism/page]", (err as Error)?.message);
    loadError = true;
  }

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold">Syllogism sprint</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Two premises, one conclusion. Judge the FORM, not how believable it
          sounds — does it follow?
        </p>
        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load a round. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          <SyllogismClient initialRound={initialRound} />
        )}
      </main>
    </div>
  );
}
