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

/** The canonical phrase, already normalized. */
const EXACT = "detroit michigan is in the eastern time zone";

/** The phrase with the place name removed — the shape variants share. */
const FRAME = "is in the eastern time zone";

/**
 * Terms that make a loose match plausibly about DTW rather than sincere
 * geography. Without this gate, real posts like "most of Indiana is in the
 * eastern time zone" would flood the review queue.
 */
const LOCAL_TERMS = ["detroit", "michigan", "dtw", "metro airport", "motor city"];

export type Classification = "exact" | "variant" | "ignore";

/**
 * Exact matches are ~100% precise and enter the feed automatically. Anything
 * carrying the frame plus a local term is a candidate riff and goes to the
 * review queue. Everything else is dropped, not stored.
 */
export function classify(text: string): Classification {
  const n = normalize(text);
  if (n.includes(EXACT)) return "exact";
  if (n.includes(FRAME) && LOCAL_TERMS.some((t) => n.includes(t))) return "variant";
  return "ignore";
}

export const postText = (p: SearchPostView): string => p.record?.text ?? "";
