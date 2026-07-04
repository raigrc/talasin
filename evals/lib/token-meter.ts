/**
 * Passive token/request meter for eval runs.
 *
 * lib/gemini/client.ts already logs `[gemini] <label> ok in Xms tokens=Y` from
 * usageMetadata on every successful call (AI_DESIGN §3 quota budget). Rather
 * than modify production code to expose usage, the evals scrape that log line.
 * Purely informational — if the log format ever changes, the meter reports 0s
 * and nothing else breaks.
 */

let totalTokens = 0;
let calls = 0;
let installed = false;

export function installTokenMeter(): void {
  if (installed) return;
  installed = true;
  const original = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    const m = line.match(/\[gemini\] .* ok in \d+ms tokens=(\d+)/);
    if (m) {
      totalTokens += Number(m[1]);
      calls += 1;
    }
    original(...(args as Parameters<typeof console.info>));
  };
}

export function tokenReport(): { calls: number; totalTokens: number } {
  return { calls, totalTokens };
}
