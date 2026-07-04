import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { listGameMeta } from "@/lib/games/registry";
import { Nav } from "@/app/Nav";

/**
 * /game — the game hub (DESIGN_V1.md §6). RSC: one card per registered game,
 * rendered from the registry's serializable metadata. Play UIs live under
 * /game/<id>; adding game #4 adds a card here automatically.
 */
export default async function GameHubPage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  const games = listGameMeta();

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold">Brain games</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Pick a drill. Every round is scored server-side and counts toward your
          streak.
        </p>
        <section className="grid gap-4 sm:grid-cols-2">
          {games.map((g) => (
            <Link
              key={g.id}
              href={g.href}
              className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--muted)]"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-medium">{g.name}</h2>
                <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  {g.pillarLabel}
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">{g.tagline}</p>
            </Link>
          ))}
        </section>
      </main>
    </div>
  );
}
