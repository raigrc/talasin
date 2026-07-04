import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * QA test harness config — deliberately separate from the Next.js build.
 *
 * `server-only` is aliased to a no-op stub (same trick as tsconfig.scripts.json
 * uses for the seed script) because it only resolves inside Next's bundler.
 * This file does NOT affect `next build` / `next dev` in any way.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // 5s default is marginal under full parallel load on this machine
    // (scrypt KDF tests + large module graphs) and causes flaky timeouts.
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "scripts/server-only-stub.ts"),
      "@": path.resolve(__dirname, "."),
    },
  },
});
