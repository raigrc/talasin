/**
 * Voice feedback eval harness (AI_DESIGN.md §1.9 — the gate RUNBOOK.md flags
 * as required "before you trust the trend charts").
 *
 * Runs known-ground-truth audio fixtures through the REAL production call path
 * (lib/gemini/client.ts analyzeInterviewAudio — same Zod validation, same
 * server-side WPM math the app stores) and checks the §1.9 gates:
 *
 *   filler accuracy   |detected - true| ≤ 1 per clip     (headline metric)
 *   WPM accuracy      app-computed WPM within ±5% of truth
 *   transcription     WER < 10% (per-fixture override for e.g. Taglish)
 *   score stability   overall/clarity vary ≤ 5 pts across repeated runs
 *
 * Usage:
 *   npm run eval:voice                       # real run (needs GEMINI_API_KEY + recorded fixtures)
 *   npm run eval:voice -- --runs 3           # stability across 3 runs per clip
 *   npm run eval:voice -- --limit 2          # only the first 2 fixtures
 *   npm run eval:voice -- --delay-ms 10000   # slower pacing for tight quotas
 *   npm run eval:voice -- --mock             # no API key: canned responses through the
 *                                            # real pipeline; self-tests that every gate
 *                                            # trips exactly as engineered
 *
 * Exit codes: 0 = gates pass (or mock self-test passes), 1 = gate FAIL,
 * 2 = nothing evaluable / config error. Fit for CI gating.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasFlag, numberFlag, stringFlag } from "./lib/args";
import { werPercent, appWordCount } from "./lib/wer";
import { heading, row, rule, verdict, pct } from "./lib/format";
import { installTokenMeter, tokenReport } from "./lib/token-meter";
import { installMockGemini, queueResponder, silentWav } from "./lib/mock-gemini";
import { analyzeInterviewAudio } from "@/lib/gemini/client";
import { GEMINI_MODEL, GeminiError } from "@/lib/gemini/config";

// --- §1.9 gates --------------------------------------------------------------
const FILLER_TOLERANCE = 1; // absolute error per clip
const WPM_MAX_ERR_PCT = 5; // percent
const WER_MAX_PCT = 10; // percent, per-fixture override via gates.wer_max_percent
const STABILITY_MAX_DELTA = 5; // points, overall_delivery_score AND clarity_score

// --- manifest schema ----------------------------------------------------------
const fixtureSchema = z.object({
  id: z.string().min(1),
  audio: z.string().nullable(),
  mime_type: z.string().optional(),
  interview_prompt: z.string().nullable().optional(),
  transcript: z.string().min(1),
  word_count: z.number().int().positive(),
  duration_seconds: z.number().positive().nullable(),
  filler_count: z.number().int().min(0),
  filler_words: z.array(
    z.object({ word: z.string(), occurrences: z.number().int().positive() }),
  ),
  target_wpm: z.number().positive().nullable().optional(),
  expected_structure: z
    .object({
      has_beginning: z.boolean(),
      has_middle: z.boolean(),
      has_end: z.boolean(),
    })
    .optional(),
  gates: z.object({ wer_max_percent: z.number().positive().optional() }).optional(),
  notes: z.string().optional(),
  // Pronunciation eval fields (optional — only on pronunciation fixtures)
  pronunciation_fixture: z.boolean().optional(),
  expected_pronunciation_categories: z.array(z.string()).optional(),
  expected_accent_label: z.string().nullable().optional(),
  expected_problem_count_min: z.number().int().min(0).optional(),
  expected_problem_count_max: z.number().int().min(0).optional(),
  expected_score_min: z.number().int().min(0).max(100).optional(),
  expected_score_max: z.number().int().min(0).max(100).optional(),
});
type Fixture = z.infer<typeof fixtureSchema>;
const manifestSchema = z.object({ fixtures: z.array(fixtureSchema).min(1) });

const gateWord = z.enum(["PASS", "FAIL"]);
const mockResponsesSchema = z.object({
  cases: z.record(
    z.string(),
    z.object({
      expected: z.object({
        filler: gateWord,
        wpm: gateWord,
        wer: gateWord,
        stability: gateWord,
        accent_stability: gateWord.optional(),
        problem_precision: gateWord.optional(),
        score_sanity: gateWord.optional(),
        empty_sanity: gateWord.optional(),
      }),
      runs: z.array(z.unknown()).min(1),
    }),
  ),
});

// --- result shapes -------------------------------------------------------------
interface RunMetrics {
  ok: true;
  fillerDetected: number;
  fillerErr: number;
  wpmComputed: number;
  wpmErrPct: number;
  werPct: number;
  clarity: number;
  overall: number;
  confidence: "high" | "low";
  structure: { has_beginning: boolean; has_middle: boolean; has_end: boolean };
  // Pronunciation fields
  pronunciationScore: number;
  accentLabel: string;
  problemSounds: { category: string; severity: string }[];
}
interface RunFailure {
  ok: false;
  error: string;
}
type RunResult = RunMetrics | RunFailure;

interface Gates {
  filler: boolean | null;
  wpm: boolean | null;
  wer: boolean | null;
  stability: boolean | null;
}
interface PronunciationGates {
  accentStability: boolean | null;
  problemPrecision: boolean | null;
  scoreSanity: boolean | null;
  emptySanity: boolean | null;
}
interface FixtureResult {
  fixture: Fixture;
  skipped?: string;
  runs: RunResult[];
  gates: Gates;
  pronGates: PronunciationGates;
  targetWpm: number;
  werMax: number;
}

const MIME_BY_EXT: Record<string, string> = {
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();
const fixturesDir = path.join(root, "evals", "fixtures");

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The manifest itself must be internally consistent before we blame the model. */
function sanityCheckFixture(f: Fixture): string[] {
  const problems: string[] = [];
  const wc = appWordCount(f.transcript);
  if (wc !== f.word_count) {
    problems.push(`word_count says ${f.word_count} but transcript has ${wc} words`);
  }
  const fillerSum = f.filler_words.reduce((a, b) => a + b.occurrences, 0);
  if (fillerSum !== f.filler_count) {
    problems.push(`filler_count says ${f.filler_count} but filler_words sum to ${fillerSum}`);
  }
  return problems;
}

function summarizeGates(r: FixtureResult): boolean {
  const gates = [r.gates.filler, r.gates.wpm, r.gates.wer, r.gates.stability];
  if (r.skipped) return false;
  if (r.runs.some((run) => !run.ok)) return false;
  // For pronunciation fixtures, also require pronunciation gates to pass
  if (r.fixture.pronunciation_fixture) {
    const pronGates = [
      r.pronGates.accentStability,
      r.pronGates.problemPrecision,
      r.pronGates.scoreSanity,
      r.pronGates.emptySanity,
    ];
    return gates.every((g) => g !== false) && pronGates.every((g) => g !== false);
  }
  return gates.every((g) => g !== false);
}

async function main(): Promise<void> {
  const mock = hasFlag("mock");
  const runsFlag = Math.floor(numberFlag("runs", 2));
  const limit = Math.floor(numberFlag("limit", Number.POSITIVE_INFINITY));
  const delayMs = mock ? 0 : numberFlag("delay-ms", 7000);

  installTokenMeter();

  // Mock plumbing: canned responses played through the REAL pipeline.
  const mockData = mock
    ? mockResponsesSchema.parse(
        loadJson(path.join(fixturesDir, "mock", "voice-responses.json")),
      )
    : null;

  const manifestPath =
    stringFlag("manifest") ??
    (mock
      ? path.join(fixturesDir, "mock", "voice-manifest.json")
      : path.join(fixturesDir, "manifest.json"));

  if (!mock && !process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is not set. Put it in .env.local (see .env.example), or use --mock to verify the harness itself without a key.",
    );
    process.exit(2);
  }

  const manifest = manifestSchema.parse(loadJson(manifestPath));
  let fixtures = manifest.fixtures.slice(0, limit);

  // Manifest self-check: ground truth must be internally consistent.
  let manifestBroken = false;
  for (const f of fixtures) {
    for (const p of sanityCheckFixture(f)) {
      console.error(`[manifest] ${f.id}: ${p}`);
      manifestBroken = true;
    }
  }
  if (manifestBroken) {
    console.error("Fix evals/fixtures/manifest.json before running (ground truth is inconsistent).");
    process.exit(2);
  }

  if (mock && mockData) {
    fixtures = fixtures.filter((f) => {
      if (!mockData.cases[f.id]) {
        console.warn(`[mock] no canned responses for ${f.id} — skipping`);
        return false;
      }
      return true;
    });
    // Queue responses in exact consumption order (fixtures x their canned runs).
    const queue: unknown[] = [];
    for (const f of fixtures) {
      for (const r of mockData.cases[f.id].runs) queue.push(r);
    }
    installMockGemini([
      {
        label: "voice",
        match: (body) => body.includes("delivery coach"),
        respond: queueResponder("voice", queue),
      },
    ]);
  }

  heading(
    `Talasin voice eval — model=${GEMINI_MODEL} ${mock ? "[MOCK: canned responses through the real pipeline]" : "[LIVE Gemini calls]"}`,
  );
  const totalRequests = fixtures.reduce(
    (a, f) => a + (mock && mockData ? mockData.cases[f.id].runs.length : runsFlag),
    0,
  );
  console.log(
    mock
      ? `${fixtures.length} mock fixtures; 0 real requests, no API key needed.`
      : `${fixtures.length} fixtures x ${runsFlag} runs = ~${totalRequests} Gemini requests, paced ${delayMs / 1000}s apart (~${Math.ceil((totalRequests * (delayMs + 4000)) / 60000)} min). Each voice call ≈ 4-5K tokens. Free-tier budget: ~${totalRequests}/250 RPD.`,
  );
  console.log(
    `Gates (AI_DESIGN §1.9): filler ±${FILLER_TOLERANCE} | WPM ≤${WPM_MAX_ERR_PCT}% err | WER <${WER_MAX_PCT}% | stability ≤${STABILITY_MAX_DELTA} pts`,
  );

  const results: FixtureResult[] = [];
  let rateLimited = false;
  let firstCall = true;

  for (const fixture of fixtures) {
    const runsForFixture =
      mock && mockData ? mockData.cases[fixture.id].runs.length : runsFlag;
    const werMax = fixture.gates?.wer_max_percent ?? WER_MAX_PCT;

    const result: FixtureResult = {
      fixture,
      runs: [],
      gates: { filler: null, wpm: null, wer: null, stability: null },
      pronGates: { accentStability: null, problemPrecision: null, scoreSanity: null, emptySanity: null },
      targetWpm: 0,
      werMax,
    };
    results.push(result);
    if (rateLimited) {
      result.skipped = "aborted: earlier rate limit";
      continue;
    }

    // Resolve inputs.
    let audio: ArrayBuffer;
    let mimeType: string;
    if (mock) {
      audio = silentWav();
      mimeType = "audio/wav";
    } else {
      if (!fixture.audio) {
        result.skipped = "no audio file listed in manifest";
        continue;
      }
      const audioPath = path.join(fixturesDir, fixture.audio);
      if (!existsSync(audioPath)) {
        result.skipped = `audio not recorded yet (${fixture.audio}) — see evals/fixtures/README.md`;
        continue;
      }
      const ext = path.extname(audioPath).toLowerCase();
      const inferred = fixture.mime_type ?? MIME_BY_EXT[ext];
      if (!inferred) {
        result.skipped = `unknown audio extension "${ext}" — set mime_type in the manifest`;
        continue;
      }
      mimeType = inferred;
      const buf = readFileSync(audioPath);
      audio = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
    if (fixture.duration_seconds === null) {
      result.skipped = "duration_seconds not filled in — measure the recording and update the manifest";
      continue;
    }
    const duration = fixture.duration_seconds;
    const targetWpm = fixture.target_wpm ?? fixture.word_count / (duration / 60);
    result.targetWpm = targetWpm;

    // Run N times through the REAL production function.
    for (let runIdx = 0; runIdx < runsForFixture; runIdx++) {
      if (!firstCall && delayMs > 0) await sleep(delayMs);
      firstCall = false;
      try {
        const fb = await analyzeInterviewAudio(
          audio,
          mimeType,
          fixture.interview_prompt ?? null,
          duration,
        );
        const wpmErrPct = (Math.abs(fb.words_per_minute - targetWpm) / targetWpm) * 100;
        result.runs.push({
          ok: true,
          fillerDetected: fb.filler_count,
          fillerErr: fb.filler_count - fixture.filler_count,
          wpmComputed: fb.words_per_minute,
          wpmErrPct,
          werPct: werPercent(fixture.transcript, fb.transcript),
          clarity: fb.clarity_score,
          overall: fb.overall_delivery_score,
          confidence: fb.confidence,
          structure: fb.structure,
          pronunciationScore: fb.pronunciation.score,
          accentLabel: fb.pronunciation.accent_label,
          problemSounds: fb.pronunciation.problem_sounds.map((ps) => ({
            category: ps.category,
            severity: ps.severity,
          })),
        });
      } catch (err) {
        if (err instanceof GeminiError && err.kind === "rate_limited") {
          console.error(
            `[${fixture.id}] rate limited — aborting remaining runs. Re-run after the quota resets (midnight Pacific).`,
          );
          rateLimited = true;
          result.runs.push({ ok: false, error: "rate_limited" });
          break;
        }
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(`[${fixture.id}] run ${runIdx + 1} failed: ${msg}`);
        result.runs.push({ ok: false, error: msg });
      }
    }

    // Gate evaluation over successful runs.
    const okRuns = result.runs.filter((r): r is RunMetrics => r.ok);
    if (okRuns.length > 0) {
      result.gates.filler = okRuns.every((r) => Math.abs(r.fillerErr) <= FILLER_TOLERANCE);
      result.gates.wpm = okRuns.every((r) => r.wpmErrPct <= WPM_MAX_ERR_PCT);
      result.gates.wer = okRuns.every((r) => r.werPct < werMax);
      if (okRuns.length >= 2) {
        const overallDelta =
          Math.max(...okRuns.map((r) => r.overall)) - Math.min(...okRuns.map((r) => r.overall));
        const clarityDelta =
          Math.max(...okRuns.map((r) => r.clarity)) - Math.min(...okRuns.map((r) => r.clarity));
        result.gates.stability =
          overallDelta <= STABILITY_MAX_DELTA && clarityDelta <= STABILITY_MAX_DELTA;
      }

      // --- Pronunciation gate evaluation (only for pronunciation fixtures) ---
      if (fixture.pronunciation_fixture && okRuns.length >= 2) {
        const f = fixture;

        // Accent stability: accent_label must be the same in >= 2/3 runs
        const accentCounts = new Map<string, number>();
        for (const r of okRuns) {
          accentCounts.set(r.accentLabel, (accentCounts.get(r.accentLabel) ?? 0) + 1);
        }
        const maxAccentCount = Math.max(...accentCounts.values());
        result.pronGates.accentStability = maxAccentCount >= 2;

        // Problem precision: at least one detected problem_sounds category
        // matches one of the expected categories
        if (f.expected_pronunciation_categories && f.expected_pronunciation_categories.length > 0) {
          const allDetectedCategories = new Set(
            okRuns.flatMap((r) => r.problemSounds.map((ps) => ps.category)),
          );
          const expectedSet = new Set(f.expected_pronunciation_categories);
          const hasMatch = [...expectedSet].some((cat) => allDetectedCategories.has(cat));
          result.pronGates.problemPrecision = hasMatch;
        } else {
          // No expected categories — precision gate passes vacuously
          result.pronGates.problemPrecision = true;
        }

        // Score sanity: issue fixtures should score lower than clean baseline
        const avgScore =
          okRuns.reduce((sum, r) => sum + r.pronunciationScore, 0) / okRuns.length;
        if (f.expected_score_min !== undefined) {
          result.pronGates.scoreSanity = avgScore >= f.expected_score_min;
        } else if (f.expected_score_max !== undefined) {
          result.pronGates.scoreSanity = avgScore <= f.expected_score_max;
        } else {
          result.pronGates.scoreSanity = true;
        }

        // Empty sanity: for clean baseline, problem_sounds should be empty or low severity
        if (f.expected_problem_count_max !== undefined) {
          const avgProblemCount =
            okRuns.reduce((sum, r) => sum + r.problemSounds.length, 0) / okRuns.length;
          result.pronGates.emptySanity = avgProblemCount <= f.expected_problem_count_max;
        } else if (f.expected_problem_count_min !== undefined) {
          const avgProblemCount =
            okRuns.reduce((sum, r) => sum + r.problemSounds.length, 0) / okRuns.length;
          result.pronGates.emptySanity = avgProblemCount >= f.expected_problem_count_min;
        } else {
          result.pronGates.emptySanity = true;
        }
      }
    }
  }

  // --- per-fixture report ------------------------------------------------------
  const W = [4, 22, 20, 8, 8, 8, 6];
  for (const r of results) {
    console.log("");
    console.log(rule());
    console.log(
      `${r.fixture.id}  (true: ${r.fixture.word_count} words, ${r.fixture.filler_count} fillers${r.fixture.duration_seconds ? `, ${r.fixture.duration_seconds}s` : ""})`,
    );
    if (r.skipped) {
      console.log(`  SKIPPED — ${r.skipped}`);
      continue;
    }
    console.log(
      row(["run", "fillers true/got/err", "WPM true/got/err%", "WER%", "clarity", "overall", "conf"], W),
    );
    r.runs.forEach((run, i) => {
      if (!run.ok) {
        console.log(row([i + 1, `ERROR: ${run.error}`, "", "", "", "", ""], W));
        return;
      }
      console.log(
        row(
          [
            i + 1,
            `${r.fixture.filler_count} / ${run.fillerDetected} / ${run.fillerErr >= 0 ? "+" : ""}${run.fillerErr}`,
            `${r.targetWpm.toFixed(1)} / ${run.wpmComputed} / ${pct(run.wpmErrPct)}`,
            pct(run.werPct),
            run.clarity,
            run.overall,
            run.confidence,
          ],
          W,
        ),
      );
    });
    const okRuns = r.runs.filter((x): x is RunMetrics => x.ok);
    const dOverall =
      okRuns.length >= 2
        ? Math.max(...okRuns.map((x) => x.overall)) - Math.min(...okRuns.map((x) => x.overall))
        : null;
    const dClarity =
      okRuns.length >= 2
        ? Math.max(...okRuns.map((x) => x.clarity)) - Math.min(...okRuns.map((x) => x.clarity))
        : null;
    console.log(
      `  gates: filler=${verdict(r.gates.filler)}  wpm=${verdict(r.gates.wpm)}  wer=${verdict(r.gates.wer)} (max ${r.werMax}%)  stability=${verdict(r.gates.stability)}${dOverall !== null ? ` (Δoverall=${dOverall} Δclarity=${dClarity})` : ""}`,
    );
    if (r.fixture.expected_structure && okRuns.length > 0) {
      const exp = r.fixture.expected_structure;
      const fmt = (s: { has_beginning: boolean; has_middle: boolean; has_end: boolean }) =>
        `B=${s.has_beginning ? "y" : "n"} M=${s.has_middle ? "y" : "n"} E=${s.has_end ? "y" : "n"}`;
      const matches = okRuns.every(
        (x) =>
          x.structure.has_beginning === exp.has_beginning &&
          x.structure.has_middle === exp.has_middle &&
          x.structure.has_end === exp.has_end,
      );
      console.log(
        `  structure (informational, not gated): expected ${fmt(exp)} | got ${okRuns.map((x) => fmt(x.structure)).join(", ")} ${matches ? "(match)" : "(MISMATCH — check manually)"}`,
      );
    }
    // Pronunciation per-fixture detail
    if (r.fixture.pronunciation_fixture && okRuns.length > 0) {
      const PW = [4, 14, 10, 12, 24];
      console.log(
        row(["run", "pron_score", "accent", "problems", "categories"], PW),
      );
      okRuns.forEach((run, i) => {
        console.log(
          row(
            [
              i + 1,
              run.pronunciationScore,
              run.accentLabel,
              run.problemSounds.length,
              run.problemSounds.map((ps) => ps.category).join(", ") || "(none)",
            ],
            PW,
          ),
        );
      });
      if (r.fixture.expected_accent_label) {
        const accentMatches = okRuns.every(
          (x) => x.accentLabel === r.fixture.expected_accent_label,
        );
        console.log(
          `  accent: expected "${r.fixture.expected_accent_label}" | got ${okRuns.map((x) => `"${x.accentLabel}"`).join(", ")} ${accentMatches ? "(match)" : "(MISMATCH)"}`,
        );
      }
      console.log(
        `  pron gates: stability=${verdict(r.pronGates.accentStability)}  precision=${verdict(r.pronGates.problemPrecision)}  score=${verdict(r.pronGates.scoreSanity)}  empty=${verdict(r.pronGates.emptySanity)}`,
      );
    }
  }

  // --- summary + verdict --------------------------------------------------------
  const evaluated = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);

  heading("VOICE EVAL SUMMARY");
  const SW = [22, 8, 8, 8, 10, 8];
  console.log(row(["fixture", "filler", "wpm", "wer", "stability", "overall"], SW));
  for (const r of results) {
    if (r.skipped) {
      console.log(row([r.fixture.id, "-", "-", "-", "-", "SKIP"], SW));
      continue;
    }
    console.log(
      row(
        [
          r.fixture.id,
          verdict(r.gates.filler),
          verdict(r.gates.wpm),
          verdict(r.gates.wer),
          verdict(r.gates.stability),
          summarizeGates(r) ? "PASS" : "FAIL",
        ],
        SW,
      ),
    );
  }

  const allPass = evaluated.length > 0 && evaluated.every(summarizeGates);
  const usage = tokenReport();
  console.log("");
  console.log(
    `requests=${usage.calls} totalTokens=${usage.totalTokens}${skipped.length > 0 ? `  |  ${skipped.length} fixture(s) skipped — record them for full §1.9 coverage` : ""}`,
  );

  // --- Pronunciation eval summary ------------------------------------------------
  const pronFixtures = evaluated.filter((r) => r.fixture.pronunciation_fixture);
  if (pronFixtures.length > 0) {
    heading("PRONUNCIATION EVAL SUMMARY");

    // Accent stability: for each fixture, is accent consistent across runs?
    const accentStable = pronFixtures.filter((r) => r.pronGates.accentStability === true).length;
    console.log(
      `Accent stability:   ${verdict(accentStable === pronFixtures.length)} (${accentStable}/${pronFixtures.length} fixtures consistent)`,
    );

    // Problem precision: did detected categories match expected?
    const problemHit = pronFixtures.filter((r) => r.pronGates.problemPrecision === true).length;
    console.log(
      `Problem precision:  ${verdict(problemHit === pronFixtures.length)} (${problemHit}/${pronFixtures.length} fixtures matched expected category)`,
    );

    // Score sanity: issue fixtures should score lower than clean baseline
    const issueFixtures = pronFixtures.filter(
      (r) => r.fixture.expected_score_max !== undefined,
    );
    const baselineFixtures = pronFixtures.filter(
      (r) => r.fixture.expected_score_min !== undefined,
    );
    const scoreSanityOk = pronFixtures.every((r) => r.pronGates.scoreSanity === true);
    if (issueFixtures.length > 0 && baselineFixtures.length > 0) {
      const issueAvg =
        issueFixtures.reduce((sum, r) => {
          const okRuns = r.runs.filter((x): x is RunMetrics => x.ok);
          return sum + okRuns.reduce((s, x) => s + x.pronunciationScore, 0) / okRuns.length;
        }, 0) / issueFixtures.length;
      const baselineAvg =
        baselineFixtures.reduce((sum, r) => {
          const okRuns = r.runs.filter((x): x is RunMetrics => x.ok);
          return sum + okRuns.reduce((s, x) => s + x.pronunciationScore, 0) / okRuns.length;
        }, 0) / baselineFixtures.length;
      console.log(
        `Score sanity:       ${verdict(scoreSanityOk)} (issue fixtures avg ${Math.round(issueAvg)}, baseline avg ${Math.round(baselineAvg)})`,
      );
    } else {
      console.log(`Score sanity:       ${verdict(scoreSanityOk)}`);
    }

    // Empty sanity: clean baseline should have few/no problem sounds
    const emptySanityOk = pronFixtures.every((r) => r.pronGates.emptySanity === true);
    if (baselineFixtures.length > 0) {
      const baselineProblemAvg =
        baselineFixtures.reduce((sum, r) => {
          const okRuns = r.runs.filter((x): x is RunMetrics => x.ok);
          return sum + okRuns.reduce((s, x) => s + x.problemSounds.length, 0) / okRuns.length;
        }, 0) / baselineFixtures.length;
      console.log(
        `Empty sanity:       ${verdict(emptySanityOk)} (baseline has ${Math.round(baselineProblemAvg)} problem sounds avg)`,
      );
    } else {
      console.log(`Empty sanity:       ${verdict(emptySanityOk)}`);
    }
  }

  console.log("");
  if (evaluated.length === 0) {
    console.log("VERDICT: NOTHING EVALUATED — no fixtures were runnable.");
    console.log("Record the fixtures per evals/fixtures/README.md, fill duration_seconds in the manifest, then re-run.");
    process.exit(2);
  }
  console.log(`OVERALL VERDICT: ${allPass ? "PASS" : "FAIL"} (${evaluated.length}/${results.length} fixtures evaluated)`);
  if (!allPass && !mock) {
    console.log(
      "Do not trust the /progress trend charts until this passes. See evals/README.md for what to tune per failing gate.",
    );
  }

  // --- mock self-test -------------------------------------------------------------
  if (mock && mockData) {
    heading("MOCK SELF-TEST — do the gates trip exactly as engineered?");
    const TW = [22, 11, 10, 8, 6];
    console.log(row(["case", "gate", "expected", "actual", "ok"], TW));
    let selfTestOk = true;
    for (const r of evaluated) {
      const expected = mockData.cases[r.fixture.id]?.expected;
      if (!expected) continue;
      const actual: Record<string, string> = {
        filler: verdict(r.gates.filler),
        wpm: verdict(r.gates.wpm),
        wer: verdict(r.gates.wer),
        stability: verdict(r.gates.stability),
      };
      // Add pronunciation gates if present in expected
      if (expected.accent_stability !== undefined) {
        actual.accent_stability = verdict(r.pronGates.accentStability);
      }
      if (expected.problem_precision !== undefined) {
        actual.problem_precision = verdict(r.pronGates.problemPrecision);
      }
      if (expected.score_sanity !== undefined) {
        actual.score_sanity = verdict(r.pronGates.scoreSanity);
      }
      if (expected.empty_sanity !== undefined) {
        actual.empty_sanity = verdict(r.pronGates.emptySanity);
      }
      for (const gate of Object.keys(expected) as Array<keyof typeof expected>) {
        const expectedVal = expected[gate];
        if (expectedVal === undefined) continue;
        const actualVal = actual[gate];
        if (actualVal === undefined) continue;
        const ok = expectedVal === actualVal;
        if (!ok) selfTestOk = false;
        console.log(row([r.fixture.id, gate, expectedVal, actualVal, ok ? "OK" : "BAD"], TW));
      }
    }
    console.log("");
    console.log(
      selfTestOk
        ? "MOCK SELF-TEST: PASS — WER/WPM/filler/stability math and gate thresholds all behave as engineered."
        : "MOCK SELF-TEST: FAIL — the harness's own math or gates are wrong. Fix evals/ before trusting a real run.",
    );
    process.exit(selfTestOk ? 0 : 1);
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("voice-eval crashed:", err);
  process.exit(2);
});
