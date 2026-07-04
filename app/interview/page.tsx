import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { getActivePrompts, type Prompt } from "@/lib/interview";
import { isGeminiConfigured } from "@/lib/gemini/client";
import { isInterviewCategory } from "@/lib/interviewCategories";
import { Nav } from "@/app/Nav";
import { RecorderClient } from "./RecorderClient";

/**
 * /interview — server shell (DESIGN.md §1; v2 per DESIGN_V1.md §4.5). Requires
 * a session, loads the seeded interview prompts server-side, then the client
 * recorder drives capture → /api/interview/feedback → structured feedback UI.
 * `?prompt=<id>` (from history's "Retry this prompt") puts that prompt first;
 * `?category=` pre-selects a category chip.
 */
export default async function InterviewPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; category?: string }>;
}) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/gate");
    throw err;
  }

  const params = await searchParams;

  let prompts: Prompt[] = [];
  let loadError = false;
  try {
    prompts = await getActivePrompts();
    // Randomize starting order so the same prompt isn't always first.
    prompts = shuffle(prompts);
  } catch (err) {
    console.error("[interview/page]", (err as Error)?.message);
    loadError = true;
  }

  // Retry-same-prompt deep link: only honor ids that exist in the active list.
  const initialPromptId =
    typeof params.prompt === "string" && prompts.some((p) => p.id === params.prompt)
      ? params.prompt
      : undefined;
  const initialCategory =
    typeof params.category === "string" && isInterviewCategory(params.category)
      ? params.category
      : undefined;

  const aiConfigured = isGeminiConfigured();

  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Voice interview practice</h1>
          <Link
            href="/interview/history"
            className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            History →
          </Link>
        </div>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Record a spoken answer and get blunt, structured delivery feedback.
        </p>

        {!aiConfigured && (
          <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm text-[var(--muted)]">
            Note: no Gemini key is configured on the server yet. You can record and
            play back, but analysis will return a clear error until{" "}
            <code>GEMINI_API_KEY</code> is set.
          </div>
        )}

        {loadError ? (
          <p className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
            Could not load interview prompts. Check the Supabase config and that{" "}
            <code>schema.sql</code> has been applied.
          </p>
        ) : (
          <RecorderClient
            prompts={prompts}
            initialPromptId={initialPromptId}
            initialCategory={initialCategory}
          />
        )}
      </main>
    </div>
  );
}

/** Fisher-Yates shuffle so prompt rotation doesn't always start at the same one. */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
