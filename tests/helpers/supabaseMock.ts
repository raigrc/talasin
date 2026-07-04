import { vi } from "vitest";

/**
 * Minimal fluent mock of the subset of the Supabase JS query builder used by
 * lib/game.ts, lib/streak.ts, lib/stats.ts, lib/interview.ts. Each table has a
 * scripted response queue; `.select().eq()...` chains resolve to whatever was
 * queued for that table via `queueResponse`.
 *
 * This is NOT a full Supabase client — it only implements the methods this
 * codebase actually calls, enough to drive lib/*.ts logic under test without a
 * network connection.
 */

export interface MockResult<T = unknown> {
  data: T | null;
  /** `code` mirrors PostgrestError.code (e.g. "23505" unique violation). */
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export function createSupabaseMock() {
  const queues = new Map<string, MockResult[]>();
  const calls: { table: string; method: string; args: unknown[] }[] = [];

  function queueResponse(table: string, result: MockResult) {
    const q = queues.get(table) ?? [];
    q.push(result);
    queues.set(table, q);
  }

  function nextResponse(table: string): MockResult {
    const q = queues.get(table);
    if (!q || q.length === 0) {
      throw new Error(`No mock response queued for table "${table}"`);
    }
    return q.length > 1 ? q.shift()! : q[0];
  }

  function makeBuilder(table: string) {
    // Thenable chain object: every method returns `this` except terminal
    // resolution, which happens when the object is awaited (via `.then`).
    const builder: Record<string, unknown> = {};
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args });
      return builder;
    };

    builder.select = (...args: unknown[]) => record("select", args);
    builder.eq = (...args: unknown[]) => record("eq", args);
    builder.gte = (...args: unknown[]) => record("gte", args);
    builder.lt = (...args: unknown[]) => record("lt", args);
    builder.in = (...args: unknown[]) => record("in", args);
    builder.order = (...args: unknown[]) => record("order", args);
    builder.limit = (...args: unknown[]) => record("limit", args);
    builder.range = (...args: unknown[]) => record("range", args);
    builder.insert = (...args: unknown[]) => record("insert", args);
    builder.upsert = (...args: unknown[]) => record("upsert", args);
    builder.delete = (...args: unknown[]) => record("delete", args);
    builder.maybeSingle = () => Promise.resolve(nextResponse(table));
    builder.single = () => Promise.resolve(nextResponse(table));
    // Thenable so `await supabase.from(t).select(...)` resolves the queued value.
    builder.then = (
      resolve: (v: MockResult) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(nextResponse(table)).then(resolve, reject);

    return builder;
  }

  const client = {
    from: vi.fn((table: string) => makeBuilder(table)),
  };

  return { client, queueResponse, calls };
}
