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

/**
 * Time zones the joke gets transplanted into (issue #4). A closed list rather
 * than "any word": the open form matches "is in the wrong time zone" and "is
 * in the same time zone", which carry no place at all.
 */
const ZONES = [
  "eastern", "central", "mountain", "pacific",
  "alaska", "hawaii(?:[- ]aleutian)?", "atlantic",
  "newfoundland", "greenwich mean", "british summer",
  "central european", "india standard",
];

/**
 * A word of a place name. Case-insensitive: the joke is typed in lowercase as
 * often as not, and a place-swap is a human decision either way, so the queue
 * takes both. The "d’" form carries its capital on the second half, and is
 * spelled out because the apostrophe would otherwise end the word.
 */
const WORD = String.raw`(?:[a-z]|d['’](?=[a-z]))[\w.'’-]*`;

/**
 * The announcement construction with the place swapped out: "Jackson Hole,
 * Wyoming is in the Mountain Time Zone", "omaha nebraska is in the central time
 * zone". Two things keep it off sincere geography:
 *
 * - **Position.** The joke is an announcement, so the place opens a clause.
 *   Sincere posts bury it mid-sentence: "most of Indiana is in the...", "we
 *   found out the hard way that South Bend is in the...", "Now consider that
 *   Thunder Bay, Ontario is in the...". All three fail here.
 * - **Length.** At most three words before the optional ", <Region>". Long
 *   enough for "Salt Lake City, Utah", short enough to exclude "I admit that
 *   Indiana is in the eastern time zone".
 *
 * The place is captured, not just matched, because PLACE_STOP has to see it.
 */
const SHAPE = new RegExp(
  // Start of post, or the start of a sentence, quotation or asterisked aside.
  String.raw`(?:^|[.!?]["'”]?\s+|[\n"“'*]\s*)` +
  // <Place>, optionally followed by <Region>.
  `(${WORD}(?:\\s+${WORD}){0,2}(?:,\\s*${WORD}(?:\\s+${WORD}){0,2})?)` +
  String.raw`,?\s+is in the\s+(?:${ZONES.join("|")})\s+time\s?zone\b`,
  "gi",
);

/**
 * Words that cannot open a place name. Matching case-insensitively is what
 * makes this necessary: capitalization used to exclude "my family is in the
 * eastern time zone" and "Most of Indiana is in the eastern time zone" for
 * free, and every one of these is a real sincere opener from the corpus or its
 * near neighbours.
 *
 * Only the first word is checked. A place name never starts with one of these,
 * and the sincere forms always do -- a determiner, a quantifier, or a subject
 * the writer is speaking about instead of announcing.
 */
const PLACE_STOP = new Set([
  "i", "we", "you", "they", "he", "she", "it",
  "my", "our", "your", "their", "his", "her", "its",
  "a", "an", "the", "this", "that", "these", "those",
  "all", "most", "much", "many", "some", "half", "none", "part", "everything",
  "here", "there", "now", "and", "but", "so", "if", "when", "why", "how",
]);

/**
 * True when the text opens a clause with a place and announces its time zone.
 * Every candidate is tried, not just the first: a post may bury one match and
 * carry a real announcement in a later sentence.
 */
function announcesAPlace(text: string): boolean {
  for (const m of text.matchAll(SHAPE)) {
    const [first = ""] = (m[1] ?? "").toLowerCase().split(/[\s,]+/);
    if (first !== "" && !PLACE_STOP.has(first)) return true;
  }
  return false;
}

export type Classification = "exact" | "variant" | "ignore";

/**
 * Exact matches are ~100% precise and enter the feed automatically. Anything
 * carrying the frame plus a local term, or the announcement construction in
 * some other time zone, is a candidate riff and goes to the review queue.
 * Everything else is dropped, not stored.
 */
export function classify(text: string): Classification {
  const n = normalize(text);
  if (EXACT.test(n)) return "exact";
  if (n.includes(FRAME) && LOCAL.test(n)) return "variant";
  // Raw text, deliberately: see SHAPE.
  if (announcesAPlace(text)) return "variant";
  return "ignore";
}

export const postText = (p: SearchPostView): string => p.record?.text ?? "";
