import { describe, it, expect } from "vitest";
import { GAMES, getGame, listGameMeta } from "@/lib/games/registry";

/**
 * Registry dispatch tests (lib/games/registry.ts, DESIGN_V1.md §3.2). The
 * registry is the source of truth for valid game types — the routes 400 on
 * anything it doesn't know.
 */

describe("getGame", () => {
  it("resolves each registered game to a definition with a matching id", () => {
    for (const id of ["fallacy", "nback", "syllogism"] as const) {
      const game = getGame(id);
      expect(game).not.toBeNull();
      expect(game!.id).toBe(id);
      expect(typeof game!.next).toBe("function");
      expect(typeof game!.answer).toBe("function");
      expect(game!.answerBody).toBeDefined();
    }
  });

  it("returns null for unknown ids", () => {
    expect(getGame("chess")).toBeNull();
    expect(getGame("")).toBeNull();
    expect(getGame("FALLACY")).toBeNull(); // case-sensitive by design
  });

  it("does not resolve prototype-chain properties as games", () => {
    expect(getGame("__proto__")).toBeNull();
    expect(getGame("toString")).toBeNull();
    expect(getGame("hasOwnProperty")).toBeNull();
  });
});

describe("listGameMeta", () => {
  it("returns serializable metadata for all three games (no functions leak to the UI)", () => {
    const metas = listGameMeta();
    expect(metas).toHaveLength(3);
    for (const meta of metas) {
      expect(Object.keys(meta).sort()).toEqual(
        ["href", "id", "name", "pillarLabel", "tagline"].sort(),
      );
      expect(meta.href).toBe(`/game/${meta.id}`);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.tagline.length).toBeGreaterThan(0);
      // Must survive RSC → client serialization.
      expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
    }
  });

  it("covers every key in GAMES exactly once", () => {
    const metas = listGameMeta();
    expect(metas.map((m) => m.id).sort()).toEqual(Object.keys(GAMES).sort());
  });
});
