import "server-only";
import { createHash } from "node:crypto";

/**
 * Content-hash for fallacy-round dedup (DESIGN.md §5). sha256 of the normalized
 * argument text: lowercase, punctuation stripped, whitespace collapsed — so
 * trivial rewordings that differ only in punctuation/case collide.
 */
export function contentHash(argumentText: string): string {
  const normalized = argumentText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // drop punctuation (unicode-aware)
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
