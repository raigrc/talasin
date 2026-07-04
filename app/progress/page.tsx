import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getStats, type Stats, type WeeklyWindowStats } from "@/lib/stats";
import { Nav } from "@/app/Nav";
import { AchievementsStrip } from "@/app/AchievementsStrip";
import { DashboardCharts } from "./DashboardCharts";

/**
 * /progress — the real dashboard (DESIGN.md §3.7, §7; v2 per DESIGN_V1.md §6).
 * Server Component reads getStats() directly (no network hop), then hands the
 * real, saved-only data to the Recharts client component. v2 adds the level/XP
 * header, the weekly insight card (rolling 7d vs prior 7d), the achievements
 * strip, and a per-game-type trend selector inside the charts.
 */
export default async function ProgressPage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let stats: Stats | null = null;
  let loadError = false;
  try {
    stats = await getStats();
  } catch (err) {
    console.error("[progress/page]", (err as Error)?.message);
    loadError = true;
  }

  const hasAnyData =
    !!stats &&
    (stats.game.total > 0 ||
      stats.interview.total > 0 ||
      stats.games.nback.total > 0 ||
      stats.games.syllogism.total > 0);

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold">Progress</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Streak, XP, and trend charts across every pillar.
        </p>

        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load your stats. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          stats && (
            <div className="flex flex-col gap-6">
              {/* Streak + level/XP + totals header. */}
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
                <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                      Current streak
                    </p>
                    <p className="mt-1 text-4xl font-semibold text-[var(--accent)]">
                      {stats.streak}
                      <span className="ml-1 text-base text-[var(--muted)]">
                        day{stats.streak === 1 ? "" : "s"}
                      </span>
                    </p>
                  </div>
                  <Stat label="Best streak" value={String(stats.best_streak)} />
                  <Stat
                    label="Level"
                    value={String(stats.xp.level)}
                    sub={`${stats.xp.total.toLocaleString()} XP · ${stats.xp.into_level}/${stats.xp.for_next} to next`}
                  />
                  <Stat
                    label="Game accuracy"
                    value={
                      stats.game.total > 0
                        ? `${Math.round(stats.game.accuracy * 100)}%`
                        : "—"
                    }
                    sub={`${stats.game.correct}/${stats.game.total} fallacy rounds`}
                  />
                  <Stat
                    label="Interview reps"
                    value={String(stats.interview.total)}
                  />
                </div>
                {stats.streak === 0 && (
                  <p className="mt-4 text-sm text-[var(--muted)]">
                    Practice today to start a streak.
                  </p>
                )}
              </section>

              {/* Weekly insight: rolling last 7 days vs the 7 before. */}
              <WeeklyInsight thisWeek={stats.weekly.this} lastWeek={stats.weekly.last} />

              {hasAnyData ? (
                <DashboardCharts stats={stats} />
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--muted)]">
                  No data yet. Play a few rounds or record an interview
                  answer, and your trends will show up here.
                </div>
              )}

              <AchievementsStrip
                unlocked={stats.achievements.map((a) => ({
                  key: a.key,
                  unlocked_at: a.unlocked_at,
                }))}
              />
            </div>
          )
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-medium text-[var(--foreground)]/85">{value}</p>
      {sub && <p className="text-xs text-[var(--muted)]">{sub}</p>}
    </div>
  );
}

/** This week vs last week (rolling 7-local-day windows, DESIGN_V1.md §4.8). */
function WeeklyInsight({
  thisWeek,
  lastWeek,
}: {
  thisWeek: WeeklyWindowStats;
  lastWeek: WeeklyWindowStats;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">This week vs last</h2>
        <span className="text-xs text-[var(--muted)]">rolling 7 days</span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <WeeklyMetric
          label="Activities"
          current={thisWeek.activities}
          prior={lastWeek.activities}
        />
        <WeeklyMetric
          label="Avg delivery"
          current={thisWeek.avg_delivery}
          prior={lastWeek.avg_delivery}
        />
        <WeeklyMetric
          label="Fillers/min"
          current={thisWeek.avg_filler_per_min}
          prior={lastWeek.avg_filler_per_min}
          lowerIsBetter
          decimals={1}
        />
        <WeeklyMetric
          label="Game accuracy"
          current={
            thisWeek.game_accuracy != null
              ? Math.round(thisWeek.game_accuracy * 100)
              : null
          }
          prior={
            lastWeek.game_accuracy != null
              ? Math.round(lastWeek.game_accuracy * 100)
              : null
          }
          suffix="%"
        />
      </div>
    </section>
  );
}

function WeeklyMetric({
  label,
  current,
  prior,
  lowerIsBetter,
  decimals = 0,
  suffix = "",
}: {
  label: string;
  current: number | null;
  prior: number | null;
  lowerIsBetter?: boolean;
  decimals?: number;
  suffix?: string;
}) {
  let deltaEl: React.ReactNode = null;
  if (current != null && prior != null) {
    const diff = current - prior;
    const improved = lowerIsBetter ? diff < 0 : diff > 0;
    const color =
      diff === 0 ? "var(--muted)" : improved ? "var(--accent-strong)" : "var(--danger)";
    deltaEl = (
      <span className="text-xs tabular-nums" style={{ color }}>
        {diff > 0 ? "+" : ""}
        {diff.toFixed(decimals)}
        {suffix}
      </span>
    );
  }
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums text-[var(--foreground)]/85">
        {current != null ? `${current.toFixed(decimals)}${suffix}` : "—"}
      </p>
      <p className="text-xs text-[var(--muted)]">
        last: {prior != null ? `${prior.toFixed(decimals)}${suffix}` : "—"} {deltaEl}
      </p>
    </div>
  );
}
