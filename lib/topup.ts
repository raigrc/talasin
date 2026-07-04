import "server-only";
import { randomUUID } from "node:crypto";
import { generateFallacyRounds } from "./gemini/client";
import { GEMINI_MODEL } from "./gemini/config";
import type { FallacyKey } from "./gemini/schemas";
import { insertGeneratedRounds, recentScenarioSummaries } from "./game";

/**
 * Shared top-up orchestration (DESIGN.md §3.5, DEPLOY.md §5).
 *
 * Both entry points reuse this: the interactive `POST /api/game/topup`
 * (session + admin-token gated) and the weekly `GET /api/cron/topup`
 * (CRON_SECRET Bearer gated). Neither the generation nor the dedup/insert
 * logic is duplicated — the routes only own their own auth + HTTP shaping.
 *
 * This is server-only: it reaches Gemini and the Supabase service-role client.
 * Any Gemini failure surfaces as the typed GeminiError from lib/gemini so the
 * caller can map it to the right status without string-matching.
 */

export interface RunTopupOptions {
  difficulty?: 1 | 2 | 3;
  fallacyKeys?: FallacyKey[];
}

export interface RunTopupResult {
  requested: number;
  generated: number;
  inserted: number;
  skipped_duplicates: number;
  needs_review: number;
  batch_id: string;
}

/**
 * Generate a batch of fallacy rounds, run the self-critique pass, dedup on
 * content_hash, and insert whatever validated (needs_review items stored but
 * never served). Returns a small summary. `count` is assumed pre-validated by
 * the caller (the POST route bounds it to 1..50 via Zod); the cron path uses
 * the default.
 */
export async function runTopup(
  count = 20,
  opts: RunTopupOptions = {},
): Promise<RunTopupResult> {
  const batchId = randomUUID();

  const avoidSummaries = await recentScenarioSummaries(50);

  const { rounds, needsReviewSummaries } = await generateFallacyRounds(count, {
    difficulty: opts.difficulty,
    fallacyKeys: opts.fallacyKeys,
    avoidSummaries,
    selfCritique: true,
  });

  const result = await insertGeneratedRounds(
    rounds,
    batchId,
    GEMINI_MODEL,
    needsReviewSummaries,
  );

  console.info(
    `[topup] batch=${batchId} requested=${count} generated=${result.generated} inserted=${result.inserted} skipped=${result.skipped_duplicates} needs_review=${needsReviewSummaries.size}`,
  );

  return {
    requested: count,
    generated: result.generated,
    inserted: result.inserted,
    skipped_duplicates: result.skipped_duplicates,
    needs_review: needsReviewSummaries.size,
    batch_id: batchId,
  };
}
