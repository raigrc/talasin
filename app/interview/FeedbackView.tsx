"use client";

/**
 * Renders the structured interview feedback as readable UI — NOT raw JSON
 * (Wave 2 brief). Shows the overall delivery score, filler words (count + which +
 * rate/min), WPM/pace, clarity, structure assessment, and the blunt coaching tips.
 * v2 (DESIGN_V1.md §4.3): STAR flags + structure score for behavioral prompts,
 * and a "vs your last attempt" delta strip when a comparable attempt exists.
 */

export interface PreviousAttemptSummary {
  attempt_id: string;
  created_at: string;
  overall_delivery_score: number | null;
  clarity_score: number | null;
  filler_per_min: number | null;
  words_per_minute: number | null;
}

export interface Feedback {
  transcript: string;
  word_count: number;
  filler_count: number;
  filler_items: { word: string; occurrences: number }[];
  filler_per_min: number;
  words_per_minute: number;
  clarity_score: number;
  structure: {
    has_beginning: boolean;
    has_middle: boolean;
    has_end: boolean;
    note: string;
  };
  structure_note: string;
  coaching: string[];
  overall_delivery_score: number;
  confidence: "high" | "low";
  // additive v1 fields (DESIGN_V1.md §4.3) — optional so pre-v1 payloads render
  star?: { situation: boolean; task: boolean; action: boolean; result: boolean } | null;
  structure_score?: number | null;
  previous?: PreviousAttemptSummary | null;
  xp_awarded?: number;
  xp_total?: number;
  level?: number;
  new_achievements?: { key: string; name: string }[];
  pronunciation?: {
    score: number;
    accent_label: string;
    accent_notes: string;
    problem_sounds: {
      category: string;
      description: string;
      examples: string[];
      severity: string;
      tip: string;
    }[];
    coaching: string[];
  };
}

/** Map a 0-100 score to a CSS var color band. */
function scoreColor(score: number): string {
  if (score >= 80) return "var(--accent-strong)";
  if (score >= 60) return "var(--accent)";
  if (score >= 40) return "#fbbf24"; // amber
  return "var(--danger)";
}

/** Format a snake_case category key into a human-readable label. */
function formatCategory(cat: string): string {
  const map: Record<string, string> = {
    th_stop: "TH Sounds",
    vowel_merger: "Vowel Merger",
    r_l_confusion: "R/L Confusion",
    short_long_vowel: "Short vs Long Vowels",
    consonant_cluster: "Consonant Clusters",
    final_consonant: "Final Consonants",
    stress_timing: "Stress & Timing",
    intonation: "Intonation",
  };
  if (map[cat]) return map[cat];
  // Fallback: replace underscores with spaces and title-case.
  return cat
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map a problem-sound severity level to a color. */
function severityColor(sev: string): string {
  if (sev === "high") return "var(--danger)";
  if (sev === "medium") return "#fbbf24";
  return "var(--muted)";
}

/** Qualitative pace label from WPM (conversational sweet spot ~130-160). */
function paceLabel(wpm: number): string {
  if (wpm === 0) return "—";
  if (wpm < 110) return "Slow";
  if (wpm <= 160) return "Good pace";
  if (wpm <= 190) return "Fast";
  return "Very fast";
}

function StructureFlag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] ${
          ok
            ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
            : "bg-[var(--danger)]/15 text-[var(--danger)]"
        }`}
      >
        {ok ? "✓" : "✕"}
      </span>
      <span className={ok ? "text-[var(--foreground)]" : "text-[var(--muted)]"}>{label}</span>
    </div>
  );
}

/** One delta cell of the "vs your last attempt" strip. */
function Delta({
  label,
  current,
  previous,
  lowerIsBetter,
  decimals = 0,
}: {
  label: string;
  current: number | null | undefined;
  previous: number | null | undefined;
  lowerIsBetter?: boolean;
  decimals?: number;
}) {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  const improved = lowerIsBetter ? diff < 0 : diff > 0;
  const color =
    diff === 0 ? "var(--muted)" : improved ? "var(--accent-strong)" : "var(--danger)";
  const sign = diff > 0 ? "+" : "";
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</span>
      <span className="text-sm tabular-nums">
        {current.toFixed(decimals)}{" "}
        <span style={{ color }}>
          ({sign}
          {diff.toFixed(decimals)})
        </span>
      </span>
    </div>
  );
}

export function FeedbackView({ feedback }: { feedback: Feedback }) {
  const {
    overall_delivery_score,
    clarity_score,
    words_per_minute,
    filler_count,
    filler_per_min,
    filler_items,
    structure,
    coaching,
    transcript,
    word_count,
    confidence,
    star,
    structure_score,
    previous,
    pronunciation,
  } = feedback;

  return (
    <div className="flex flex-col gap-5">
      {/* Overall delivery score — the headline number. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
          Overall delivery
        </p>
        <div className="mt-1 flex items-end gap-3">
          <span
            className="text-5xl font-semibold tabular-nums"
            style={{ color: scoreColor(overall_delivery_score) }}
          >
            {overall_delivery_score}
          </span>
          <span className="pb-1.5 text-sm text-[var(--muted)]">/ 100</span>
        </div>
        {confidence === "low" && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Low confidence — the transcript may be imprecise (fast or unclear
            speech). Treat the numbers as approximate.
          </p>
        )}
      </div>

      {/* "vs your last attempt" delta strip (same prompt, else same category). */}
      {previous && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">
            vs your last attempt
          </p>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Delta
              label="Delivery"
              current={overall_delivery_score}
              previous={previous.overall_delivery_score}
            />
            <Delta label="Clarity" current={clarity_score} previous={previous.clarity_score} />
            <Delta
              label="Fillers/min"
              current={filler_per_min}
              previous={previous.filler_per_min}
              lowerIsBetter
              decimals={1}
            />
            <Delta
              label="WPM"
              current={words_per_minute}
              previous={previous.words_per_minute}
            />
          </div>
        </div>
      )}

      {/* Metric grid: clarity, pace/WPM, filler rate. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric
          label="Clarity"
          value={String(clarity_score)}
          suffix="/ 100"
          color={scoreColor(clarity_score)}
        />
        <Metric
          label="Pace"
          value={String(words_per_minute)}
          suffix={`wpm · ${paceLabel(words_per_minute)}`}
        />
        <Metric
          label="Filler rate"
          value={filler_per_min.toFixed(1)}
          suffix="per min"
          color={filler_per_min <= 3 ? "var(--accent-strong)" : filler_per_min <= 6 ? "var(--accent)" : "var(--danger)"}
        />
      </div>

      {/* Filler words breakdown. */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Filler words</h3>
          <span className="text-sm text-[var(--muted)]">
            {filler_count} total · {filler_per_min.toFixed(1)}/min
          </span>
        </div>
        {filler_items.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No filler words detected. Clean delivery.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {filler_items.map((f) => (
              <span
                key={f.word}
                className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs text-[var(--foreground)]"
              >
                &ldquo;{f.word}&rdquo; ×{f.occurrences}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Structure assessment: strict STAR rubric for behavioral prompts,
          the loose beginning/middle/end heuristic otherwise (§4.3). */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">
            {star ? "Structure (STAR)" : "Structure"}
          </h3>
          {star && typeof structure_score === "number" && (
            <span
              className="text-sm font-semibold tabular-nums"
              style={{ color: scoreColor(structure_score) }}
            >
              {structure_score} / 100
            </span>
          )}
        </div>
        {star ? (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StructureFlag label="Situation" ok={star.situation} />
            <StructureFlag label="Task" ok={star.task} />
            <StructureFlag label="Action" ok={star.action} />
            <StructureFlag label="Result" ok={star.result} />
          </div>
        ) : (
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:gap-6">
            <StructureFlag label="Beginning" ok={structure.has_beginning} />
            <StructureFlag label="Middle" ok={structure.has_middle} />
            <StructureFlag label="End" ok={structure.has_end} />
          </div>
        )}
        {structure.note && (
          <p className="text-sm text-[var(--muted)]">{structure.note}</p>
        )}
      </div>

      {/* Pronunciation analysis. */}
      {pronunciation && (() => {
        const pr = pronunciation;
        return (
          <>
            {/* Score card */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-medium">Pronunciation</h3>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-medium capitalize"
                  >
                    {pr.accent_label}
                  </span>
                </div>
              </div>
              <div className="flex items-end gap-3">
                <span
                  className="text-4xl font-semibold tabular-nums"
                  style={{ color: scoreColor(pr.score) }}
                >
                  {pr.score}
                </span>
                <span className="pb-1 text-sm text-[var(--muted)]">/ 100</span>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">{pr.accent_notes}</p>
            </div>

            {/* Problem sounds */}
            {pr.problem_sounds.length > 0 && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
                <h3 className="mb-3 text-sm font-medium">Problem Sounds</h3>
                <div className="flex flex-col gap-3">
                  {pr.problem_sounds.slice(0, 5).map((ps, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-2 rounded-md bg-[var(--surface-2)] p-4"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-flex h-2.5 w-2.5 flex-none rounded-full"
                          style={{ backgroundColor: severityColor(ps.severity) }}
                        />
                        <span className="text-sm font-medium">
                          {formatCategory(ps.category)}
                        </span>
                        <span className="text-xs capitalize text-[var(--muted)]">
                          {ps.severity}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--foreground)]/90">
                        {ps.description}
                      </p>
                      {ps.examples.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {ps.examples.map((w) => (
                            <span
                              key={w}
                              className="rounded bg-[var(--border)]/40 px-2 py-0.5 text-xs text-[var(--foreground)]/75"
                            >
                              &ldquo;{w}&rdquo;
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-[var(--muted)]">💡 {ps.tip}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Pronunciation coaching */}
            {pr.coaching.length > 0 && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
                <h3 className="mb-3 text-sm font-medium">Pronunciation Coaching</h3>
                <ul className="flex flex-col gap-2">
                  {pr.coaching.map((tip, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span className="text-[var(--accent)]">→</span>
                      <span className="text-[var(--foreground)]/90">{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        );
      })()}

      {/* Blunt coaching tips. */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-sm font-medium">Coaching</h3>
        <ul className="flex flex-col gap-2">
          {coaching.map((tip, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className="text-[var(--accent)]">→</span>
              <span className="text-[var(--foreground)]/90">{tip}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Transcript (collapsible). */}
      <details className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <summary className="cursor-pointer text-sm font-medium">
          Transcript ({word_count} words)
        </summary>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]/85">
          {transcript}
        </p>
      </details>
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: string;
  suffix: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </p>
      <p className="text-xs text-[var(--muted)]">{suffix}</p>
    </div>
  );
}
