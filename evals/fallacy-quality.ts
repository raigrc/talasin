/**
 * Fallacy content quality eval (AI_DESIGN.md §2.9).
 *
 * Generates batches through the REAL production path (lib/gemini/client.ts
 * generateFallacyRounds — same prompts, schema enforcement, guardrails and
 * self-critique the app uses), then:
 *
 *   (a) re-checks the §2.8 structural guardrails on every surviving round
 *       (4 distinct taxonomy options, correct ∈ options, explanation length,
 *       answer-position spread, within-run duplicates);
 *   (b) blind second-opinion check: an independent Gemini call per batch is
 *       shown ONLY the argument + 4 options (what a player sees, no answer
 *       key) and asked to identify the fallacy. Agreement rate vs the stored
 *       label is the automated proxy for §2.9 label precision (gate ≥ 90%);
 *   (c) ambiguity: rounds the production self-critique flags as multi-fallacy
 *       (needs_review) vs the §2.9 < 5% ambiguous gate.
 *
 * Every disagreement is listed for human review and written (with everything
 * else) to evals/output/fallacy-review.csv for manual spot-checking — §2.9's
 * human precision check.
 *
 * COST: each batch = 2 requests (generation + self-critique) + 1 judge request
 * → the default 2 batches ≈ 6 Gemini requests total (~4 with --no-critique).
 *
 * Usage:
 *   npm run eval:fallacy                       # 2 batches x 10 rounds (~6 requests)
 *   npm run eval:fallacy -- --batches 3 --batch-size 8
 *   npm run eval:fallacy -- --no-critique      # skip the self-critique pass
 *   npm run eval:fallacy -- --mock             # canned batches through the real
 *                                              # pipeline; self-tests the math + gates
 *
 * Exit codes: 0 = gates pass (or mock self-test passes), 1 = gate FAIL,
 * 2 = config/transport error.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasFlag, numberFlag } from "./lib/args";
import { heading, row, rule, verdict, pct } from "./lib/format";
import { installTokenMeter, tokenReport } from "./lib/token-meter";
import { installMockGemini, queueResponder } from "./lib/mock-gemini";
import { judgeRounds, JUDGE_MARKER } from "./lib/judge";
import { generateFallacyRounds } from "@/lib/gemini/client";
import { GEMINI_MODEL, GeminiError } from "@/lib/gemini/config";
import { FALLACY_KEYS, type FallacyKey, type GeneratedRound } from "@/lib/gemini/schemas";

// --- §2.9 gates ---------------------------------------------------------------
const PRECISION_MIN_PCT = 90; // blind-judge agreement (proxy for label precision)
const AMBIGUOUS_MAX_PCT = 5; // needs_review (multi-fallacy) rate
// Structural violations must be zero — the production guardrails should make
// them impossible, so any hit here means a lib/ or harness bug.

const gateWord = z.enum(["PASS", "FAIL"]);
const mockFileSchema = z.object({
  expected: z.object({
    survivors_per_batch: z.array(z.number().int()),
    judged: z.number().int(),
    agreements: z.number().int(),
    agreement_percent: z.number(),
    needs_review: z.number().int(),
    needs_review_percent: z.number(),
    structural_violations: z.number().int(),
    gates: z.object({ precision: gateWord, ambiguity: gateWord, structural: gateWord }),
    disagreement_summaries: z.array(z.string()),
  }),
  generation_batches: z.array(z.object({ rounds: z.array(z.unknown()) })),
  critique_responses: z.array(z.unknown()),
  judge_responses: z.array(z.unknown()),
});

interface EvalRound {
  batch: number;
  index: number; // index within the batch's surviving rounds
  round: GeneratedRound;
  needsReview: boolean;
  judged: FallacyKey | null;
  agree: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();

/** Re-check the §2.8 structural guardrails on a surviving round. */
function structuralViolations(r: GeneratedRound): string[] {
  const v: string[] = [];
  const keys = r.choices.map((c) => c.key);
  if (keys.length !== 4) v.push(`has ${keys.length} options (want 4)`);
  if (new Set(keys).size !== keys.length) v.push("duplicate options");
  const taxonomy: readonly string[] = FALLACY_KEYS;
  for (const k of keys) if (!taxonomy.includes(k)) v.push(`option "${k}" outside taxonomy`);
  if (!keys.includes(r.correct_key)) v.push("correct_key not among options");
  if (r.explanation.trim().length < 120) v.push("explanation under 120 chars");
  if (![1, 2, 3].includes(r.difficulty)) v.push(`difficulty ${r.difficulty} not 1..3`);
  return v;
}

/** §2.8 soft check: the explanation should actually name the fallacy it teaches. */
function explanationMentionsFallacy(r: GeneratedRound): boolean {
  const label = r.choices.find((c) => c.key === r.correct_key)?.label ?? "";
  const haystack = r.explanation.toLowerCase();
  const keyWords = r.correct_key.replace(/_/g, " ");
  return haystack.includes(keyWords) || (label !== "" && haystack.includes(label.toLowerCase()));
}

function csvEscape(value: string | number | boolean): string {
  const s = String(value).replace(/\r?\n/g, " ");
  return `"${s.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const mock = hasFlag("mock");
  const critique = !hasFlag("no-critique");
  installTokenMeter();

  let mockData: z.infer<typeof mockFileSchema> | null = null;
  let batches: number;
  let batchSize: number;
  let delayMs: number;

  if (mock) {
    mockData = mockFileSchema.parse(
      JSON.parse(
        readFileSync(path.join(root, "evals", "fixtures", "mock", "fallacy-mock.json"), "utf8"),
      ),
    );
    batches = mockData.generation_batches.length;
    batchSize = 10; // requested count; the canned payload decides what comes back
    delayMs = 0;
    installMockGemini([
      {
        label: "generation",
        match: (body) => body.includes("curriculum designer"),
        respond: queueResponder("generation", [...mockData.generation_batches]),
      },
      {
        label: "critique",
        match: (body) => body.includes("strict logic reviewer"),
        respond: queueResponder("critique", [...mockData.critique_responses]),
      },
      {
        label: "judge",
        match: (body) => body.includes(JUDGE_MARKER),
        respond: queueResponder("judge", [...mockData.judge_responses]),
      },
    ]);
  } else {
    batches = Math.floor(numberFlag("batches", 2));
    batchSize = Math.floor(numberFlag("batch-size", 10));
    delayMs = numberFlag("delay-ms", 7000);
    if (!process.env.GEMINI_API_KEY) {
      console.error(
        "GEMINI_API_KEY is not set. Put it in .env.local (see .env.example), or use --mock to verify the harness itself without a key.",
      );
      process.exit(2);
    }
  }

  const requestEstimate = batches * ((critique ? 2 : 1) + 1);
  heading(
    `Talasin fallacy content eval — model=${GEMINI_MODEL} ${mock ? "[MOCK: canned responses through the real pipeline]" : "[LIVE Gemini calls]"}`,
  );
  console.log(
    mock
      ? `${batches} canned batches; 0 real requests, no API key needed.`
      : `COST: ${batches} batches x ${batchSize} rounds = ~${requestEstimate} Gemini requests (${batches} generation${critique ? ` + ${batches} self-critique` : ""} + ${batches} blind judge), paced ${delayMs / 1000}s apart. Free-tier budget: ~${requestEstimate}/250 RPD.`,
  );
  console.log(
    `Gates (AI_DESIGN §2.9): blind-judge agreement ≥${PRECISION_MIN_PCT}% (label-precision proxy) | needs_review <${AMBIGUOUS_MAX_PCT}% | structural violations = 0`,
  );
  console.log(
    "Note: the blind judge is the same Flash model (free tier), independently prompted with no answer key — treat agreement as an optimistic proxy and hand-review every disagreement.",
  );

  // --- generate + judge ----------------------------------------------------------
  const all: EvalRound[] = [];
  const survivorsPerBatch: number[] = [];
  const avoid: string[] = [];

  for (let b = 0; b < batches; b++) {
    if (b > 0 && delayMs > 0) await sleep(delayMs);
    let rounds: GeneratedRound[];
    let needsReviewSummaries: Set<string>;
    try {
      const res = await generateFallacyRounds(batchSize, {
        selfCritique: critique,
        avoidSummaries: avoid.length > 0 ? avoid : undefined,
      });
      rounds = res.rounds;
      needsReviewSummaries = res.needsReviewSummaries;
    } catch (err) {
      if (err instanceof GeminiError && err.kind === "rate_limited") {
        console.error("Rate limited during generation — re-run after the quota resets (midnight Pacific).");
        process.exit(2);
      }
      throw err;
    }
    avoid.push(...rounds.map((r) => r.scenario_summary));
    survivorsPerBatch.push(rounds.length);
    console.log(
      `batch ${b + 1}: requested ${batchSize}, got ${rounds.length} valid rounds (model under-delivery or §2.8 guardrail drops account for the difference), ${needsReviewSummaries.size} flagged needs_review`,
    );

    if (rounds.length === 0) continue;
    if (delayMs > 0) await sleep(delayMs);
    let judged: Map<number, FallacyKey>;
    try {
      judged = await judgeRounds(rounds);
    } catch (err) {
      console.error(`blind judge failed on batch ${b + 1}: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }

    rounds.forEach((round, i) => {
      const j = judged.get(i) ?? null;
      all.push({
        batch: b + 1,
        index: i,
        round,
        needsReview: needsReviewSummaries.has(round.scenario_summary),
        judged: j,
        agree: j !== null && j === round.correct_key,
      });
    });
  }

  if (all.length === 0) {
    console.error("No valid rounds came back — nothing to evaluate.");
    process.exit(2);
  }

  // --- (a) structural re-check ----------------------------------------------------
  heading("STRUCTURAL GUARDRAIL RE-CHECK (AI_DESIGN §2.8)");
  let violationCount = 0;
  const softWarnings: string[] = [];
  const positionHist = [0, 0, 0, 0];
  const seenSummaries = new Map<string, string>();
  for (const er of all) {
    const id = `batch${er.batch}#${er.index}`;
    for (const v of structuralViolations(er.round)) {
      violationCount++;
      console.log(`  VIOLATION ${id}: ${v}`);
    }
    if (!explanationMentionsFallacy(er.round)) {
      softWarnings.push(`${id}: explanation never names "${er.round.correct_key}"`);
    }
    const dupOf = seenSummaries.get(er.round.scenario_summary);
    if (dupOf) softWarnings.push(`${id}: scenario_summary duplicates ${dupOf}`);
    seenSummaries.set(er.round.scenario_summary, id);
    const pos = er.round.choices.findIndex((c) => c.key === er.round.correct_key);
    if (pos >= 0 && pos < 4) positionHist[pos]++;
  }
  console.log(`  violations: ${violationCount} (must be 0 — production guardrails filter these)`);
  console.log(`  correct-answer position spread A/B/C/D: ${positionHist.join("/")}`);
  const maxPos = Math.max(...positionHist);
  if (all.length >= 5 && maxPos / all.length > 0.7) {
    softWarnings.push(`correct answer sits in one position ${maxPos}/${all.length} times — shuffle may be broken`);
  }
  for (const w of softWarnings) console.log(`  warning: ${w}`);
  if (softWarnings.length === 0) console.log("  no soft warnings");

  // --- (b)+(c) agreement + ambiguity ------------------------------------------------
  const judgedRounds = all.filter((r) => r.judged !== null);
  const agreements = all.filter((r) => r.agree).length;
  const unanswered = all.length - judgedRounds.length;
  // A judge that skips a round gets counted as a disagreement — silence is not agreement.
  const agreementPct = (agreements / all.length) * 100;
  const needsReviewCount = all.filter((r) => r.needsReview).length;
  const needsReviewPct = (needsReviewCount / all.length) * 100;

  heading("BLIND SECOND-OPINION CHECK (label-precision proxy, AI_DESIGN §2.9)");
  const W = [10, 6, 22, 22, 8, 8];
  console.log(row(["batch#idx", "diff", "labeled", "blind judge", "agree", "review"], W));
  for (const er of all) {
    console.log(
      row(
        [
          `b${er.batch}#${er.index}`,
          er.round.difficulty,
          er.round.correct_key,
          er.judged ?? "(no answer)",
          er.agree ? "yes" : "NO",
          er.needsReview ? "FLAG" : "-",
        ],
        W,
      ),
    );
  }
  console.log("");
  console.log(
    `agreement: ${agreements}/${all.length} = ${pct(agreementPct)}${unanswered > 0 ? ` (${unanswered} unanswered, counted as disagreement)` : ""}`,
  );
  console.log(`needs_review (self-critique ambiguity): ${needsReviewCount}/${all.length} = ${pct(needsReviewPct)}`);

  const disagreements = all.filter((r) => !r.agree || r.needsReview);
  if (disagreements.length > 0) {
    console.log("");
    console.log("REVIEW THESE BY HAND (disagreed or flagged — read the argument, decide if the label is truly the one committed):");
    for (const er of disagreements) {
      console.log(rule("-", 60));
      console.log(
        `  b${er.batch}#${er.index} [${er.round.scenario_summary}]\n  labeled=${er.round.correct_key} judge=${er.judged ?? "(none)"} needs_review=${er.needsReview}\n  ${er.round.argument_text}`,
      );
    }
  }

  // --- CSV for manual spot-checking -------------------------------------------------
  const outDir = path.join(root, "evals", "output");
  mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, "fallacy-review.csv");
  const header = [
    "batch",
    "index",
    "difficulty",
    "correct_fallacy",
    "blind_judge",
    "agree",
    "needs_review",
    "scenario_summary",
    "argument",
    "explanation",
  ].join(",");
  const lines = all.map((er) =>
    [
      er.batch,
      er.index,
      er.round.difficulty,
      er.round.correct_key,
      er.judged ?? "",
      er.agree,
      er.needsReview,
      csvEscape(er.round.scenario_summary),
      csvEscape(er.round.argument_text),
      csvEscape(er.round.explanation),
    ].join(","),
  );
  writeFileSync(csvPath, [header, ...lines].join("\n") + "\n", "utf8");
  console.log("");
  console.log(`wrote ${all.length} rounds to ${csvPath} for manual spot-checking`);

  // --- verdict -----------------------------------------------------------------------
  const precisionPass = agreementPct >= PRECISION_MIN_PCT;
  const ambiguityPass = needsReviewPct < AMBIGUOUS_MAX_PCT;
  const structuralPass = violationCount === 0;
  const allPass = precisionPass && ambiguityPass && structuralPass;

  heading("FALLACY CONTENT VERDICT");
  const VW = [26, 30, 30];
  console.log(row(["gate", "threshold", "result"], VW));
  console.log(row(["label precision (proxy)", `agreement ≥ ${PRECISION_MIN_PCT}%`, `${verdict(precisionPass)} (${pct(agreementPct)})`], VW));
  console.log(row(["ambiguity", `needs_review < ${AMBIGUOUS_MAX_PCT}%`, `${verdict(ambiguityPass)} (${pct(needsReviewPct)})`], VW));
  console.log(row(["structural guardrails", "0 violations", `${verdict(structuralPass)} (${violationCount})`], VW));
  const usage = tokenReport();
  console.log("");
  console.log(`requests=${usage.calls} totalTokens=${usage.totalTokens}`);
  console.log("");
  console.log(`OVERALL VERDICT: ${allPass ? "PASS" : "FAIL"}`);
  if (!allPass && !mock) {
    console.log(
      "Below-gate content: keep auto-approve OFF (rounds stay needs_review), hand-review the CSV, and tighten lib/gemini/prompts.ts before seeding more. See evals/README.md.",
    );
  }

  // --- mock self-test -----------------------------------------------------------------
  if (mock && mockData) {
    heading("MOCK SELF-TEST — does the harness compute exactly what was engineered?");
    const exp = mockData.expected;
    const checks: Array<[string, string | number, string | number]> = [
      ["survivors per batch", exp.survivors_per_batch.join(","), survivorsPerBatch.join(",")],
      ["rounds judged", exp.judged, all.length],
      ["agreements", exp.agreements, agreements],
      ["agreement %", exp.agreement_percent.toFixed(1), agreementPct.toFixed(1)],
      ["needs_review", exp.needs_review, needsReviewCount],
      ["needs_review %", exp.needs_review_percent.toFixed(1), needsReviewPct.toFixed(1)],
      ["structural violations", exp.structural_violations, violationCount],
      ["precision gate", exp.gates.precision, verdict(precisionPass)],
      ["ambiguity gate", exp.gates.ambiguity, verdict(ambiguityPass)],
      ["structural gate", exp.gates.structural, verdict(structuralPass)],
      [
        "disagreement set",
        [...exp.disagreement_summaries].sort().join(" | "),
        [...new Set(all.filter((r) => !r.agree).map((r) => r.round.scenario_summary))].sort().join(" | "),
      ],
    ];
    const TW = [24, 44, 44];
    console.log(row(["check", "expected", "actual"], TW));
    let selfTestOk = true;
    for (const [name, expected, actual] of checks) {
      const ok = String(expected) === String(actual);
      if (!ok) selfTestOk = false;
      console.log(row([`${ok ? "OK " : "BAD"} ${name}`, expected, actual], TW));
    }
    console.log("");
    console.log(
      selfTestOk
        ? "MOCK SELF-TEST: PASS — guardrail drops, agreement math, ambiguity math, and both §2.9 gates behave as engineered."
        : "MOCK SELF-TEST: FAIL — the harness's own math or gates are wrong. Fix evals/ before trusting a real run.",
    );
    process.exit(selfTestOk ? 0 : 1);
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("fallacy-quality crashed:", err);
  process.exit(2);
});
