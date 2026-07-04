import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Durable login limiter tests (lib/loginLimiter.ts, DESIGN_V1.md §4.6):
 * window math, threshold, opportunistic pruning, and the FAIL-OPEN posture on
 * Supabase errors (stated trade-off §7 — the scrypt passphrase is the real
 * gate; the limiter is a cheap pre-KDF shield).
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
});

describe("checkLoginAllowed", () => {
  it("allows when window failures are under LOGIN_MAX_FAILS", async () => {
    const { checkLoginAllowed, LOGIN_MAX_FAILS } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune
    mock.queueResponse("login_attempts", { data: null, error: null, count: LOGIN_MAX_FAILS - 1 });
    await expect(checkLoginAllowed("1.1.1.1")).resolves.toBe(true);
  });

  it("blocks at exactly LOGIN_MAX_FAILS failures", async () => {
    const { checkLoginAllowed, LOGIN_MAX_FAILS } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: LOGIN_MAX_FAILS });
    await expect(checkLoginAllowed("1.1.1.1")).resolves.toBe(false);
  });

  it("counts only THIS ip's failures inside the 15-minute window", async () => {
    const { checkLoginAllowed, LOGIN_WINDOW_MIN } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });

    const now = new Date("2026-07-03T12:00:00.000Z");
    await checkLoginAllowed("9.9.9.9", now);

    const eqCalls = mock.calls.filter(
      (c) => c.table === "login_attempts" && c.method === "eq",
    );
    expect(eqCalls.some((c) => c.args[0] === "ip" && c.args[1] === "9.9.9.9")).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === "success" && c.args[1] === false)).toBe(true);

    const gte = mock.calls.find((c) => c.table === "login_attempts" && c.method === "gte");
    expect(gte!.args[0]).toBe("attempted_at");
    expect(gte!.args[1]).toBe(
      new Date(now.getTime() - LOGIN_WINDOW_MIN * 60_000).toISOString(),
    );
  });

  it("prunes rows older than 24h before counting", async () => {
    const { checkLoginAllowed } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });

    const now = new Date("2026-07-03T12:00:00.000Z");
    await checkLoginAllowed("1.1.1.1", now);

    const del = mock.calls.find((c) => c.table === "login_attempts" && c.method === "delete");
    expect(del).toBeTruthy();
    const lt = mock.calls.find((c) => c.table === "login_attempts" && c.method === "lt");
    expect(lt!.args[0]).toBe("attempted_at");
    expect(lt!.args[1]).toBe(new Date(now.getTime() - 24 * 3_600_000).toISOString());
  });

  it("FAILS OPEN (returns true) when the window count errors", async () => {
    const { checkLoginAllowed } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune ok
    mock.queueResponse("login_attempts", { data: null, error: { message: "db down" } });
    await expect(checkLoginAllowed("1.1.1.1")).resolves.toBe(true);
  });

  it("a prune failure is swallowed — the window count still runs", async () => {
    const { checkLoginAllowed } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: { message: "prune boom" } });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 99 });
    // Count succeeded and is over the limit → still blocks despite prune failing.
    await expect(checkLoginAllowed("1.1.1.1")).resolves.toBe(false);
  });

  it("a missing count (null) is treated as zero failures", async () => {
    const { checkLoginAllowed } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: null });
    await expect(checkLoginAllowed("1.1.1.1")).resolves.toBe(true);
  });
});

describe("recordLoginAttempt", () => {
  it("inserts the ip + success outcome", async () => {
    const { recordLoginAttempt } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    await recordLoginAttempt("2.2.2.2", true);
    const insert = mock.calls.find(
      (c) => c.table === "login_attempts" && c.method === "insert",
    );
    expect(insert!.args[0]).toEqual({ ip: "2.2.2.2", success: true });
  });

  it("swallows an insert error (fail-open — never blocks the login path)", async () => {
    const { recordLoginAttempt } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: { message: "boom" } });
    await expect(recordLoginAttempt("2.2.2.2", false)).resolves.toBeUndefined();
  });
});
