import { ACHIEVEMENTS, type UnlockedRow } from "@/lib/achievements";

/**
 * Locked/unlocked achievements strip (DESIGN_V1.md §6) — shared by home and
 * /progress. Server Component: the catalog lives in server-only code; only
 * plain strings hit the wire. No dark patterns — locked ones are neutral,
 * not nagging.
 */
export function AchievementsStrip({ unlocked }: { unlocked: UnlockedRow[] }) {
  const unlockedByKey = new Map(unlocked.map((u) => [u.key, u.unlocked_at]));

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Achievements</h2>
        <span className="text-xs text-[var(--muted)]">
          {unlockedByKey.size} / {ACHIEVEMENTS.length}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ACHIEVEMENTS.map((a) => {
          const unlockedAt = unlockedByKey.get(a.key);
          return (
            <li
              key={a.key}
              title={a.description}
              className={`rounded-lg border p-2.5 text-xs ${
                unlockedAt
                  ? "border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10"
                  : "border-[var(--border)] bg-[var(--surface-2)] opacity-60"
              }`}
            >
              <p
                className={`font-medium ${
                  unlockedAt ? "text-[var(--accent-strong)]" : "text-[var(--muted)]"
                }`}
              >
                {a.name}
              </p>
              <p className="mt-0.5 text-[var(--muted)]">{a.description}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
