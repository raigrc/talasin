/**
 * Seed the fallacy_rounds pool for first-run content (DESIGN.md §2, AI_DESIGN §2.6).
 *
 * Generates ~300 rounds in paced batches of 10 (≤10 RPM to respect the free-tier
 * limit), deduping into the DB on content_hash. Idempotent: re-running skips
 * duplicates and simply tops up toward the target.
 *
 * Run:
 *   npm run seed:fallacy               # default 300 rounds
 *   npm run seed:fallacy -- --count 50 # custom target
 *
 * Requires GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv(); // fall back to .env if present

import { generateFallacyRounds } from "@/lib/gemini/client";
import { GEMINI_MODEL, GeminiError } from "@/lib/gemini/config";
import { insertGeneratedRounds, recentScenarioSummaries } from "@/lib/game";
import { getServiceClient } from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";

const BATCH_SIZE = 10;
const PACE_MS = 7_000; // ~1 call / 7s → under 10 RPM (AI_DESIGN §2.6)

function parseArgs(): { count: number } {
  const args = process.argv.slice(2);
  const i = args.indexOf("--count");
  const count = i >= 0 && args[i + 1] ? Number(args[i + 1]) : 300;
  return { count: Number.isFinite(count) && count > 0 ? count : 300 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function currentActiveCount(): Promise<number> {
  const supabase = getServiceClient();
  const { count, error } = await supabase
    .from("fallacy_rounds")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (error) throw new Error(`count read failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const { count: target } = parseArgs();

  // Fail fast with a clear message if env is missing.
  for (const key of ["GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[key]) {
      console.error(`Missing ${key}. Set it in .env.local before seeding.`);
      process.exit(1);
    }
  }

  const startCount = await currentActiveCount();
  console.log(`Active rounds now: ${startCount}. Target: ${target}.`);

  let totalInserted = 0;
  let totalGenerated = 0;
  let totalSkipped = 0;
  let batchNum = 0;

  while ((await currentActiveCount()) < target) {
    batchNum += 1;
    const remaining = target - (startCount + totalInserted);
    const batchCount = Math.min(BATCH_SIZE, Math.max(1, remaining));

    try {
      const avoid = await recentScenarioSummaries(50);
      const { rounds, needsReviewSummaries } = await generateFallacyRounds(batchCount, {
        avoidSummaries: avoid,
        selfCritique: true,
      });
      const res = await insertGeneratedRounds(
        rounds,
        randomUUID(),
        GEMINI_MODEL,
        needsReviewSummaries,
      );
      totalGenerated += res.generated;
      totalInserted += res.inserted;
      totalSkipped += res.skipped_duplicates;
      console.log(
        `Batch ${batchNum}: generated=${res.generated} inserted=${res.inserted} skipped=${res.skipped_duplicates} needs_review=${needsReviewSummaries.size}`,
      );
    } catch (err) {
      if (err instanceof GeminiError && err.kind === "rate_limited") {
        console.warn("Rate limited — stopping. Re-run later to continue toward the target.");
        break;
      }
      console.error(`Batch ${batchNum} failed:`, (err as Error)?.message);
      // Keep going; a single bad batch shouldn't kill the whole seed.
    }

    // Safety valve: if a batch produced nothing new for several rounds, stop.
    if (batchNum > Math.ceil(target / BATCH_SIZE) * 3) {
      console.warn("Too many batches without reaching target — stopping to avoid a loop.");
      break;
    }

    await sleep(PACE_MS);
  }

  const finalCount = await currentActiveCount();
  console.log(
    `\nDone. generated=${totalGenerated} inserted=${totalInserted} skipped_duplicates=${totalSkipped}. Active rounds: ${finalCount}.`,
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
