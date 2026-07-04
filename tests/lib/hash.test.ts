import { describe, it, expect } from "vitest";
import { contentHash } from "@/lib/hash";

/**
 * Content-hash normalization tests (lib/hash.ts, DESIGN.md §5). This hash is
 * the dedup guard for fallacy_rounds — trivial rewordings differing only in
 * case/punctuation/whitespace must collide so top-ups don't insert near-dupes.
 */

describe("contentHash", () => {
  it("is deterministic for identical input", () => {
    const text = "This is a test argument.";
    expect(contentHash(text)).toBe(contentHash(text));
  });

  it("is case-insensitive (normalizes to lowercase)", () => {
    expect(contentHash("Hello World")).toBe(contentHash("hello world"));
  });

  it("ignores punctuation differences", () => {
    expect(contentHash("Hello, World!")).toBe(contentHash("Hello World"));
  });

  it("collapses repeated whitespace", () => {
    expect(contentHash("Hello   World")).toBe(contentHash("Hello World"));
  });

  it("ignores leading/trailing whitespace", () => {
    expect(contentHash("  Hello World  ")).toBe(contentHash("Hello World"));
  });

  it("produces different hashes for genuinely different arguments", () => {
    expect(contentHash("Argument one about cats")).not.toBe(contentHash("Argument two about dogs"));
  });

  it("handles unicode letters (does not strip accented characters)", () => {
    // \p{L} keeps unicode letters, so accented chars survive normalization,
    // meaning café and cafe are NOT treated as identical.
    expect(contentHash("café")).not.toBe(contentHash("cafe"));
  });

  it("handles empty string without throwing", () => {
    expect(() => contentHash("")).not.toThrow();
    expect(contentHash("")).toBe(contentHash(""));
  });

  it("returns a 64-char hex sha256 digest", () => {
    const hash = contentHash("some argument text");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("mixed punctuation + case + spacing rewording still collides (the core dedup guarantee)", () => {
    const a = "My Coworker missed ONE deadline, so he's clearly incompetent!";
    const b = "my coworker missed one deadline so hes clearly incompetent";
    // Apostrophe is punctuation and gets stripped, so "he's" -> "hes" matches "hes".
    expect(contentHash(a)).toBe(contentHash(b));
  });
});
