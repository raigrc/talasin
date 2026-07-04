import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getStreaks } from "@/lib/streak";
import { getDailyGoal, getXpTotal, type DailyGoal } from "@/lib/progression";
import { levelFromXp, type LevelInfo } from "@/lib/xp";
import { getUnlockedAchievements, type UnlockedRow } from "@/lib/achievements";
import { Nav } from "@/app/Nav";
import { AchievementsStrip } from "@/app/AchievementsStrip";

/**
 * Home v2 (DESIGN_V1.md §6) — the "open this every day" screen. Server
 * Component: streak, level/XP bar, the two-segment daily-goal ring (pure
 * inline SVG, §5.3), achievements strip, and the pillar cards. No dark
 * patterns: a missed goal is a neutral empty ring, no guilt copy.
 */
export default async function HomePage() {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  let streak = 0;
  let bestStreak = 0;
  let level: LevelInfo | null = null;
  let xpTotal = 0;
  let goal: DailyGoal | null = null;
  let unlocked: UnlockedRow[] = [];
  let statsError = false;
  try {
    const [streaks, xp, dailyGoal, achievements] = await Promise.all([
      getStreaks(),
      getXpTotal(),
      getDailyGoal(),
      getUnlockedAchievements(),
    ]);
    streak = streaks.streak;
    bestStreak = streaks.bestStreak;
    xpTotal = xp;
    level = levelFromXp(xp);
    goal = dailyGoal;
    unlocked = achievements;
  } catch (err) {
    console.error("[home]", (err as Error)?.message);
    statsError = true;
  }

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
          {statsError ? (
            <p className="text-sm text-[var(--danger)]">
              Could not load your streak. Check the Supabase config and that{" "}
              <code>schema.sql</code> is applied.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
              <div>
                <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                  Current streak
                </p>
                <p className="mt-1 text-4xl font-semibold text-[var(--accent)]">
                  {streak}
                  <span className="ml-1 text-base text-[var(--muted)]">
                    day{streak === 1 ? "" : "s"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">Best: {bestStreak}</p>
              </div>

              {level && (
                <div className="min-w-[160px] flex-1">
                  <div className="flex items-baseline justify-between">
                    <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                      Level {level.level}
                    </p>
                    <p className="text-xs tabular-nums text-[var(--muted)]">
                      {xpTotal.toLocaleString()} XP
                    </p>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent-strong)]"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round((level.into_level / Math.max(1, level.for_next)) * 100),
                        )}%`,
                      }}
                    />
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-[var(--muted)]">
                    {level.into_level} / {level.for_next} XP to level {level.level + 1}
                  </p>
                </div>
              )}

              {goal && <DailyGoalRing goal={goal} />}
            </div>
          )}
          {streak === 0 && !statsError && (
            <p className="mt-4 text-sm text-[var(--muted)]">
              Practice today to start a streak.
            </p>
          )}
        </section>

        {/* Daily goal checklist. */}
        {goal && !statsError && (
          <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="mb-3 text-sm font-medium">Today&rsquo;s goal</h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-8">
              <GoalItem done={goal.game_done} label="Play a brain game" href="/game" />
              <GoalItem
                done={goal.interview_done}
                label="Record an interview answer"
                href="/interview"
              />
            </div>
          </section>
        )}

        <section className="mb-6 grid gap-4 sm:grid-cols-2">
          <PillarCard
            href="/game"
            title="Brain games"
            body="Spot the fallacy, dual n-back, syllogism sprint. Scored server-side."
          />
          <PillarCard
            href="/interview"
            title="Voice interview"
            body="Record a spoken answer and get blunt, structured delivery feedback."
          />
          <PillarCard
            href="/progress"
            title="Progress"
            body="Streak, XP, achievements, and trend charts across every pillar."
          />
        </section>

        {!statsError && <AchievementsStrip unlocked={unlocked} />}

        <p className="mt-6 text-center">
          <Link
            href="/admin"
            className="text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            Admin · content pool
          </Link>
        </p>
      </main>
    </div>
  );
}

/**
 * Two-segment daily-goal ring (§5.3): left half = game, right half = interview.
 * Pure inline SVG in the RSC — no client component needed.
 */
function DailyGoalRing({ goal }: { goal: DailyGoal }) {
  const R = 26;
  const C = 2 * Math.PI * R; // circumference
  const half = C / 2;
  const doneColor = "var(--accent-strong)";
  const idleColor = "var(--surface-2)";
  const doneCount = (goal.game_done ? 1 : 0) + (goal.interview_done ? 1 : 0);

  return (
    <div className="flex items-center gap-3">
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden>
        {/* Right half: interview segment (drawn from 12 o'clock, clockwise). */}
        <circle
          cx="36"
          cy="36"
          r={R}
          fill="none"
          stroke={goal.interview_done ? doneColor : idleColor}
          strokeWidth="7"
          strokeDasharray={`${half - 3} ${half + 3}`}
          transform="rotate(-90 36 36)"
          strokeLinecap="round"
        />
        {/* Left half: game segment. */}
        <circle
          cx="36"
          cy="36"
          r={R}
          fill="none"
          stroke={goal.game_done ? doneColor : idleColor}
          strokeWidth="7"
          strokeDasharray={`${half - 3} ${half + 3}`}
          transform="rotate(90 36 36)"
          strokeLinecap="round"
        />
        <text
          x="36"
          y="40"
          textAnchor="middle"
          className="fill-[var(--foreground)]"
          fontSize="13"
          fontWeight="600"
        >
          {doneCount}/2
        </text>
      </svg>
      <div>
        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Daily goal</p>
        <p className="text-sm text-[var(--foreground)]/85">
          {doneCount === 2
            ? "Done for today."
            : doneCount === 1
              ? "One pillar to go."
              : "One game + one interview."}
        </p>
      </div>
    </div>
  );
}

function GoalItem({ done, label, href }: { done: boolean; label: string; href: string }) {
  return (
    <Link href={href} className="group flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] ${
          done
            ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
            : "bg-[var(--surface-2)] text-[var(--muted)]"
        }`}
      >
        {done ? "✓" : ""}
      </span>
      <span
        className={
          done
            ? "text-[var(--muted)] line-through"
            : "text-[var(--foreground)] transition-colors group-hover:text-[var(--accent)]"
        }
      >
        {label}
      </span>
    </Link>
  );
}

function PillarCard({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--muted)]"
    >
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </Link>
  );
}
