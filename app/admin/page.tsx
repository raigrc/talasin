import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getPoolStatus, type PoolStatus } from "@/lib/game";
import { Nav } from "@/app/Nav";
import { TopupPanel } from "./TopupPanel";

/**
 * /admin — content-pool status + top-up panel (DESIGN_V1.md §4.7). RSC,
 * session-gated like every page. The top-up POST itself is additionally gated
 * by the x-talasin-admin token, typed per use in the client panel and NEVER
 * persisted — a stolen session cookie alone still can't burn Gemini quota.
 */
export default async function AdminPage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let pool: PoolStatus | null = null;
  let loadError = false;
  try {
    pool = await getPoolStatus();
  } catch (err) {
    console.error("[admin/page]", (err as Error)?.message);
    loadError = true;
  }

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Admin</h1>
          <Link
            href="/"
            className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            ← Home
          </Link>
        </div>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Fallacy content-pool status and Gemini-backed top-up.
        </p>

        {loadError ? (
          <p className="mb-6 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load the pool status. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          pool && (
            <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h2 className="mb-3 text-sm font-medium">Content pool</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <PoolStat label="Total rounds" value={pool.total} />
                <PoolStat label="Active" value={pool.by_status.active ?? 0} />
                <PoolStat label="Unseen today" value={pool.unseen_today} />
                <PoolStat label="Needs review" value={pool.by_status.needs_review ?? 0} />
              </div>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--muted)]">
                <span>
                  Active by difficulty — easy:{" "}
                  <span className="tabular-nums text-[var(--foreground)]">
                    {pool.active_by_difficulty["1"] ?? 0}
                  </span>
                </span>
                <span>
                  medium:{" "}
                  <span className="tabular-nums text-[var(--foreground)]">
                    {pool.active_by_difficulty["2"] ?? 0}
                  </span>
                </span>
                <span>
                  hard:{" "}
                  <span className="tabular-nums text-[var(--foreground)]">
                    {pool.active_by_difficulty["3"] ?? 0}
                  </span>
                </span>
                {pool.by_status.retired != null && (
                  <span>
                    retired:{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {pool.by_status.retired}
                    </span>
                  </span>
                )}
              </div>
            </section>
          )
        )}

        <TopupPanel />
      </main>
    </div>
  );
}

function PoolStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums text-[var(--foreground)]/85">
        {value}
      </p>
    </div>
  );
}
