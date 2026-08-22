import type { SearchPostView } from "./types.ts";

/**
 * Fold text to a comparable form: lowercase, strip accents, reduce every
 * non-alphanumeric run to a single space. This makes "Detroit, Michigan is in
 * the Eastern Time Zone" and "detroit michigan is in the eastern time zone"
 * identical, which matters because the joke is retyped from memory each time.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The canonical phrase. The state is written out, abbreviated, or clipped
 * newspaper-style, and all three are the same joke: the archive already holds
 * "Detroit, MI is in the Eastern Time Zone" posts that only got in by hand.
 */
const EXACT = /\bdetroit (?:michigan|mich|mi) is in the eastern time zone\b/;

/** The phrase with the place name removed — the shape variants share. */
const FRAME = "is in the eastern time zone";

/**
 * Terms that make a loose match plausibly about DTW rather than sincere
 * geography. Without this gate, real posts like "most of Indiana is in the
 * eastern time zone" would flood the review queue.
 *
 * Matched on word boundaries, not as substrings: "mi" appears inside "admit",
 * "midwest" and "miles", and would otherwise admit most of the sincere posts
 * this list exists to exclude.
 */
const LOCAL_TERMS = [
  "detroit", "michigan", "mich", "mi", "dtw", "metro airport", "motor city",
];
const LOCAL = new RegExp(`\\b(?:${LOCAL_TERMS.join("|")})\\b`);

export type Classification = "exact" | "variant" | "ignore";

/**
 * Exact matches are ~100% precise and enter the feed automatically. Anything
 * carrying the frame plus a local term is a candidate riff and goes to the
 * review queue. Everything else is dropped, not stored.
 */
export function classify(text: string): Classification {
  const n = normalize(text);
  if (EXACT.test(n)) return "exact";
  if (n.includes(FRAME) && LOCAL.test(n)) return "variant";
  return "ignore";
}

export const postText = (p: SearchPostView): string => p.record?.text ?? "";
