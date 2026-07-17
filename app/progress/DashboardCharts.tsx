"use client";

import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  type TooltipProps,
} from "recharts";
import type { Stats } from "@/lib/stats";

/**
 * Progress dashboard charts (DESIGN.md §7 — Recharts; v2 per DESIGN_V1.md §6:
 * per-game-type trend selector tabs on the game card). Client component
 * (charts need the DOM). Renders ONLY from real saved stats; empty windows
 * render an empty-state instead of a chart. Colors come from the app CSS vars.
 */

type GameTab = "fallacy" | "nback" | "syllogism";

const GAME_TABS: { id: GameTab; label: string }[] = [
  { id: "fallacy", label: "Fallacy" },
  { id: "nback", label: "N-back" },
  { id: "syllogism", label: "Syllogism" },
];

const ACCENT = "#34d399"; // --accent-strong
const ACCENT_SOFT = "#6ee7b7"; // --accent
const DANGER = "#f87171"; // --danger
const AMBER = "#fbbf24";
const GRID = "rgba(255,255,255,0.06)";
const AXIS = "#9a9ab0"; // --muted

/** Short axis label: 2026-06-25 → 06-25. */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

function ChartCard({
  title,
  subtitle,
  children,
  hasData,
  emptyHint,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  hasData: boolean;
  emptyHint: string;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
      </div>
      {hasData ? (
        <div className="h-56 w-full">{children}</div>
      ) : (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted)]">
          {emptyHint}
        </div>
      )}
    </section>
  );
}

function TooltipBox({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-[var(--foreground)]">{label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} style={{ color: (p.color as string) ?? AXIS }}>
          {p.name}: <span className="tabular-nums">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export function DashboardCharts({ stats }: { stats: Stats }) {
  const [gameTab, setGameTab] = useState<GameTab>("fallacy");

  const gameTrend = stats.game.trend.map((d) => ({
    day: shortDay(d.local_day),
    accuracy: Math.round(d.accuracy * 100),
    count: d.count,
  }));

  const nbackTrend = stats.games.nback.trend.map((d) => ({
    day: shortDay(d.local_day),
    score: d.avg_score,
    maxN: d.max_n,
  }));

  const syllogismTrend = stats.games.syllogism.trend.map((d) => ({
    day: shortDay(d.local_day),
    accuracy: Math.round(d.accuracy * 100),
    count: d.count,
  }));

  const ivFillerTrend = stats.interview.trend.map((d) => ({
    day: shortDay(d.local_day),
    filler: d.avg_filler_rate,
  }));

  const ivQualityTrend = stats.interview.trend.map((d) => ({
    day: shortDay(d.local_day),
    clarity: d.avg_clarity,
    delivery: d.avg_delivery,
  }));

  const pronunciationTrend =
    stats.pronunciation?.trend.map((d) => ({
      day: shortDay(d.local_day),
      pronunciation: d.avg_pronunciation,
    })) ?? [];

  const gameCardMeta: Record<
    GameTab,
    { title: string; subtitle: string; empty: string; hasData: boolean }
  > = {
    fallacy: {
      title: "Fallacy accuracy",
      subtitle: "Correct-answer rate per day (recent rounds)",
      empty: "Play some fallacy rounds to see your accuracy trend.",
      hasData: gameTrend.length > 0,
    },
    nback: {
      title: "N-back score",
      subtitle: `Average session score per day (current N: ${stats.games.nback.current_n})`,
      empty: "Play an n-back session to start this trend.",
      hasData: nbackTrend.length > 0,
    },
    syllogism: {
      title: "Syllogism accuracy",
      subtitle: "Correct-answer rate per day (recent rounds)",
      empty: "Run a syllogism sprint to start this trend.",
      hasData: syllogismTrend.length > 0,
    },
  };
  const activeMeta = gameCardMeta[gameTab];

  return (
    <div className="flex flex-col gap-6">
      {/* Per-game trend with type selector tabs (DESIGN_V1.md §6). */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium">{activeMeta.title}</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">{activeMeta.subtitle}</p>
          </div>
          <div className="flex gap-1">
            {GAME_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setGameTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  gameTab === t.id
                    ? "bg-[var(--surface-2)] text-[var(--foreground)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {activeMeta.hasData ? (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {gameTab === "nback" ? (
                <LineChart
                  data={nbackTrend}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="day" stroke={AXIS} fontSize={11} tickLine={false} />
                  <YAxis
                    stroke={AXIS}
                    fontSize={11}
                    tickLine={false}
                    domain={[0, 100]}
                    width={44}
                  />
                  <Tooltip content={<TooltipBox />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="score"
                    name="Score"
                    stroke={ACCENT}
                    strokeWidth={2}
                    dot={{ r: 3, fill: ACCENT }}
                  />
                  <Line
                    type="monotone"
                    dataKey="maxN"
                    name="Max N"
                    stroke={AMBER}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={{ r: 3, fill: AMBER }}
                  />
                </LineChart>
              ) : (
                <AreaChart
                  data={gameTab === "fallacy" ? gameTrend : syllogismTrend}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="accFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="day" stroke={AXIS} fontSize={11} tickLine={false} />
                  <YAxis
                    stroke={AXIS}
                    fontSize={11}
                    tickLine={false}
                    domain={[0, 100]}
                    unit="%"
                    width={44}
                  />
                  <Tooltip content={<TooltipBox />} />
                  <Area
                    type="monotone"
                    dataKey="accuracy"
                    name="Accuracy"
                    unit="%"
                    stroke={ACCENT}
                    strokeWidth={2}
                    fill="url(#accFill)"
                    dot={{ r: 3, fill: ACCENT }}
                  />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted)]">
            {activeMeta.empty}
          </div>
        )}
      </section>

      {/* Interview filler-rate trend (lower is better). */}
      <ChartCard
        title="Filler words"
        subtitle="Average fillers per minute per day (lower is better)"
        hasData={ivFillerTrend.length > 0}
        emptyHint="Record an interview answer to start tracking filler rate."
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={ivFillerTrend} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" stroke={AXIS} fontSize={11} tickLine={false} />
            <YAxis stroke={AXIS} fontSize={11} tickLine={false} width={44} allowDecimals />
            <Tooltip content={<TooltipBox />} />
            <Line
              type="monotone"
              dataKey="filler"
              name="Fillers/min"
              stroke={DANGER}
              strokeWidth={2}
              dot={{ r: 3, fill: DANGER }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Interview clarity + delivery trend (higher is better). */}
      <ChartCard
        title="Delivery & clarity"
        subtitle="Average scores per day (0-100, higher is better)"
        hasData={ivQualityTrend.length > 0}
        emptyHint="Record an interview answer to start tracking delivery."
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={ivQualityTrend} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" stroke={AXIS} fontSize={11} tickLine={false} />
            <YAxis stroke={AXIS} fontSize={11} tickLine={false} domain={[0, 100]} width={44} />
            <Tooltip content={<TooltipBox />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="delivery"
              name="Delivery"
              stroke={ACCENT}
              strokeWidth={2}
              dot={{ r: 3, fill: ACCENT }}
            />
            <Line
              type="monotone"
              dataKey="clarity"
              name="Clarity"
              stroke={ACCENT_SOFT}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={{ r: 3, fill: ACCENT_SOFT }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Pronunciation trend (only when data exists). */}
      {stats.pronunciation && pronunciationTrend.length > 0 && (
        <ChartCard
          title="Pronunciation"
          subtitle={`Average score per day (0-100). Accent: ${stats.pronunciation.top_accent ?? "—"}${
            stats.pronunciation.top_problem_sounds.length > 0
              ? ` · Focus: ${stats.pronunciation.top_problem_sounds.join(", ")}`
              : ""
          }`}
          hasData
          emptyHint=""
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={pronunciationTrend}
              margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
            >
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="day" stroke={AXIS} fontSize={11} tickLine={false} />
              <YAxis
                stroke={AXIS}
                fontSize={11}
                tickLine={false}
                domain={[0, 100]}
                width={44}
              />
              <Tooltip content={<TooltipBox />} />
              <Line
                type="monotone"
                dataKey="pronunciation"
                name="Pronunciation"
                stroke={ACCENT}
                strokeWidth={2}
                dot={{ r: 3, fill: ACCENT }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Per-fallacy accuracy (weakest first is useful, but we show most-played). */}
      {stats.game.by_fallacy.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h2 className="mb-4 text-sm font-medium">Accuracy by fallacy</h2>
          <ul className="flex flex-col gap-2.5">
            {stats.game.by_fallacy.map((f) => {
              const pct = Math.round(f.accuracy * 100);
              const color = pct >= 70 ? ACCENT : pct >= 40 ? AMBER : DANGER;
              return (
                <li key={f.fallacy_key} className="text-xs">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[var(--foreground)]/90">
                      {f.fallacy_key.replace(/_/g, " ")}
                    </span>
                    <span className="tabular-nums text-[var(--muted)]">
                      {pct}% · {f.count}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
