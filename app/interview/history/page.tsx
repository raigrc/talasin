import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import {
  listAttempts,
  getPersonalBests,
  type AttemptListItem,
  type PersonalBests,
} from "@/lib/interview";
import {
  INTERVIEW_CATEGORIES,
  CATEGORY_LABELS,
  categoryLabel,
  isInterviewCategory,
} from "@/lib/interviewCategories";
import { Nav } from "@/app/Nav";

/**
 * /interview/history — RSC attempt history (DESIGN_V1.md §4.5): personal-bests
 * card up top, paged newest-first list with `?page=N&category=` searchParams,
 * expandable transcripts via plain <details> (no client JS needed), and a
 * "Retry this prompt" link per row → /interview?prompt=<id>.
 */

const PAGE_SIZE = 10;

export default async function InterviewHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; category?: string }>;
}) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const category =
    typeof params.category === "string" && isInterviewCategory(params.category)
      ? params.category
      : undefined;

  let items: AttemptListItem[] = [];
  let total = 0;
  let bests: PersonalBests | null = null;
  let loadError = false;
  try {
    [{ items, total }, bests] = await Promise.all([
      listAttempts({ page, pageSize: PAGE_SIZE, category }),
      getPersonalBests(),
    ]);
  } catch (err) {
    console.error("[interview/history]", (err as Error)?.message);
    loadError = true;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) =>
    `/interview/history?page=${p}${category ? `&category=${category}` : ""}`;

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Interview history</h1>
          <Link
            href="/interview"
            className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            ← Practice
          </Link>
        </div>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Every attempt, newest first. Personal bests up top.
        </p>

        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load your history. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Personal bests. */}
            {bests && (
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
                <h2 className="mb-3 text-sm font-medium">Personal bests</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Best label="Delivery" entry={bests.best_delivery} suffix="/ 100" />
                  <Best label="Clarity" entry={bests.best_clarity} suffix="/ 100" />
                  <Best
                    label="Fillers/min"
                    entry={bests.best_filler_per_min}
                    suffix="lowest"
                    decimals={1}
                  />
                  <Best
                    label="STAR structure"
                    entry={bests.best_structure_score}
                    suffix="/ 100"
                  />
                </div>
              </section>
            )}

            {/* Category filter. */}
            <div className="flex flex-wrap gap-2">
              <FilterChip href="/interview/history" active={!category} label="All" />
              {INTERVIEW_CATEGORIES.map((c) => (
                <FilterChip
                  key={c}
                  href={`/interview/history?category=${c}`}
                  active={category === c}
                  label={CATEGORY_LABELS[c]}
                />
              ))}
            </div>

            {/* Attempt list. */}
            {items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--muted)]">
                No attempts {category ? "in this category " : ""}yet. Record one
                and it will show up here.
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((a) => (
                  <AttemptRow key={a.id} attempt={a} />
                ))}
              </ul>
            )}

            {/* Pagination. */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between text-sm">
                {page > 1 ? (
                  <Link
                    href={pageHref(page - 1)}
                    className="text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
                  >
                    ← Newer
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-[var(--muted)]">
                  Page {page} of {totalPages} · {total} attempts
                </span>
                {page < totalPages ? (
                  <Link
                    href={pageHref(page + 1)}
                    className="text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
                  >
                    Older →
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Best({
  label,
  entry,
  suffix,
  decimals = 0,
}: {
  label: string;
  entry: { value: number; local_day: string } | null;
  suffix: string;
  decimals?: number;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      {entry ? (
        <>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--accent)]">
            {entry.value.toFixed(decimals)}
          </p>
          <p className="text-xs text-[var(--muted)]">
            {suffix} · {entry.local_day}
          </p>
        </>
      ) : (
        <p className="mt-1 text-2xl font-medium text-[var(--muted)]">—</p>
      )}
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
          : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {label}
    </Link>
  );
}

function AttemptRow({ attempt }: { attempt: AttemptListItem }) {
  const dur = attempt.duration_sec ?? 0;
  const fillerPerMin =
    dur > 0 ? Math.round((attempt.filler_count / (dur / 60)) * 10) / 10 : null;

  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
          {attempt.local_day} · {categoryLabel(attempt.category)}
        </span>
        {attempt.prompt_id && (
          <Link
            href={`/interview?prompt=${attempt.prompt_id}`}
            className="text-xs text-[var(--accent)] transition-colors hover:text-[var(--accent-strong)]"
          >
            Retry this prompt →
          </Link>
        )}
      </div>
      <p className="mb-3 text-sm leading-relaxed">
        {attempt.prompt_text ?? "Ad-hoc answer (no prompt)"}
      </p>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums text-[var(--muted)]">
        <span>
          Delivery{" "}
          <span className="text-[var(--foreground)]">
            {attempt.overall_delivery_score ?? "—"}
          </span>
        </span>
        <span>
          Clarity{" "}
          <span className="text-[var(--foreground)]">{attempt.clarity_score ?? "—"}</span>
        </span>
        <span>
          Fillers/min{" "}
          <span className="text-[var(--foreground)]">
            {fillerPerMin != null ? fillerPerMin.toFixed(1) : "—"}
          </span>
        </span>
        <span>
          WPM{" "}
          <span className="text-[var(--foreground)]">
            {attempt.words_per_minute != null ? Math.round(attempt.words_per_minute) : "—"}
          </span>
        </span>
        {attempt.structure_score != null && (
          <span>
            STAR{" "}
            <span className="text-[var(--foreground)]">{attempt.structure_score}</span>
          </span>
        )}
      </div>
      {attempt.star && (
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          {(
            [
              ["S", attempt.star.situation],
              ["T", attempt.star.task],
              ["A", attempt.star.action],
              ["R", attempt.star.result],
            ] as const
          ).map(([letter, ok]) => (
            <span
              key={letter}
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${
                ok
                  ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
                  : "bg-[var(--danger)]/15 text-[var(--danger)]"
              }`}
            >
              {letter}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">
            Transcript
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]/85">
            {attempt.transcript}
          </p>
        </details>
      </div>
    </li>
  );
}
