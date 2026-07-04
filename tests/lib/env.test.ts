import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules(); // APP_TZ is computed once at module load — need a fresh import per test
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("requireEnv / optionalEnv", () => {
  it("requireEnv returns the value when set", async () => {
    process.env.TEST_VAR = "hello";
    const { requireEnv } = await import("@/lib/env");
    expect(requireEnv("TEST_VAR")).toBe("hello");
  });

  it("requireEnv throws a clear error when unset", async () => {
    delete process.env.TEST_VAR;
    const { requireEnv } = await import("@/lib/env");
    expect(() => requireEnv("TEST_VAR")).toThrow(/Missing required environment variable: TEST_VAR/);
  });

  it("requireEnv throws when set to an empty string (treated as unset)", async () => {
    process.env.TEST_VAR = "";
    const { requireEnv } = await import("@/lib/env");
    expect(() => requireEnv("TEST_VAR")).toThrow();
  });

  it("optionalEnv returns undefined when unset, does not throw", async () => {
    delete process.env.TEST_VAR;
    const { optionalEnv } = await import("@/lib/env");
    expect(optionalEnv("TEST_VAR")).toBeUndefined();
  });

  it("optionalEnv treats empty string as undefined", async () => {
    process.env.TEST_VAR = "";
    const { optionalEnv } = await import("@/lib/env");
    expect(optionalEnv("TEST_VAR")).toBeUndefined();
  });

  it("APP_TZ defaults to Asia/Manila when TALASIN_TZ is unset", async () => {
    delete process.env.TALASIN_TZ;
    const { APP_TZ } = await import("@/lib/env");
    expect(APP_TZ).toBe("Asia/Manila");
  });
});
