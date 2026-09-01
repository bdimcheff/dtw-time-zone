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
 * Words that are not a time zone name. The zone slot is otherwise open, which
 * is the opposite of how this started: an allowlist of world time zones is a
 * gazetteer that never finishes losing. "Athens, Greece is in the Eastern
 * European Time Zone" and "Istanbul, Turkey is in the Turkey Time Zone" are
 * both real posts that an allowlist of US zones dropped.
 *
 * A blocklist finishes, because the noise is always a determiner or an
 * adjective -- "is in the wrong time zone" -- never a place's actual zone.
 * Only the word next to "the" is checked; "the wrong damn time zone" is caught
 * by "wrong".
 */
const ZONE_STOP = new Set([
  "wrong", "same", "right", "other", "another", "different", "correct",
  "local", "current", "best", "worst", "future", "past", "opposite", "next",
]);

/**
 * A word of a place name. Case-insensitive: the joke is typed in lowercase as
 * often as not, and a place-swap is a human decision either way, so the queue
 * takes both. The "d’" form carries its capital on the second half, and is
 * spelled out because the apostrophe would otherwise end the word.
 */
const WORD = String.raw`(?:[a-z]|d['’](?=[a-z]))[\w.'’-]*`;
/** Later words may be numeric: "ZIP Code 48242 is in the Eastern Time Zone". */
const TOKEN = `(?:${WORD}|\\d[\\w.-]*)`;

/**
 * The announcement construction with the place swapped out: "Jackson Hole,
 * Wyoming is in the Mountain Time Zone", "omaha nebraska is in the central time
 * zone". Three things keep it off sincere geography:
 *
 * - **Position.** The joke is an announcement, so the place opens a clause.
 *   Sincere posts bury it mid-sentence: "most of Indiana is in the...", "we
 *   found out the hard way that South Bend is in the...", "Now consider that
 *   Thunder Bay, Ontario is in the...". All three fail here.
 * - **Length.** At most three words, then at most two more after an optional
 *   comma. Long enough for "Salt Lake City, Utah", short enough to exclude "I
 *   admit that Indiana is in the eastern time zone". The comma half is the
 *   tighter of the two on purpose: as three-and-three it let six words through
 *   ("It's absolutely bananas, especially when Alabama is in the...").
 * - **PLACE_STOP / ZONE_STOP.** Below.
 *
 * The place and the zone are both captured, because those two lists have to
 * see them.
 */
const SHAPE = new RegExp(
  // Start of post, sentence, line, or an opening quotation. A quote only opens
  // a clause when it follows whitespace -- mid-word it is an apostrophe, and
  // treating it as a boundary invents a clause start that skips PLACE_STOP.
  String.raw`(^|[.!?]["'”]?\s+|\n\s*|(?<=^|\s)["“']\s*)` +
  // <Place>, optionally followed by <Region>.
  `(${WORD}(?:\\s+${TOKEN}){0,2}(?:,\\s*${WORD}(?:\\s+${TOKEN}){0,1})?)` +
  // "is in the <Zone> Time Zone", where <Zone> is one to three words. Three
  // covers "Hawaii-Aleutian Standard" and "Greenwich Mean".
  String.raw`,?\s+is in the\s+((?:[\w-]+\s+){0,2}[\w-]+)\s+time\s*zone\b`,
  "gi",
);

/**
 * Emphasis markers are removed rather than treated as clause boundaries. As a
 * boundary, the closing "*" of "my *entire* family is in the eastern time zone"
 * manufactures a clause start at "family" and hides "my" from PLACE_STOP --
 * which is the one case that list is named after. Removing them instead leaves
 * the real subject intact for it to reject.
 */
const EMPHASIS = /[*_]/g;

/**
 * Words that cannot open a place name. Matching case-insensitively is what
 * makes this necessary: capitalization used to exclude "my family is in the
 * eastern time zone" and "Most of Indiana is in the eastern time zone" for
 * free. Every entry is a real sincere opener seen in a live search.
 *
 * Only the first word is checked, with a possessive or contraction clipped off
 * first -- "It's absolutely bananas, ..." would otherwise slip past "it".
 */
const PLACE_STOP = new Set([
  "i", "we", "you", "they", "he", "she", "it",
  "my", "our", "your", "their", "his", "her", "its",
  "a", "an", "the", "this", "that", "these", "those",
  "all", "most", "much", "many", "some", "half", "none", "part", "everything",
  "here", "there", "now", "and", "but", "so", "if", "when", "why", "how",
  "since", "til", "tho", "fyi", "uh", "um", "well", "remember",
  "apparently", "fortunately", "unfortunately", "even", "to", "for", "because",
  "also", "still", "just", "only", "maybe", "probably", "honestly", "everyone",
]);

/** Trim a possessive or contraction so "it's" is recognised as "it". */
const bare = (w: string) => w.replace(/['’]\w*$/, "");

/**
 * True when the text opens a clause with a place and announces its time zone.
 * Every candidate is tried, not just the first: a post may bury one match and
 * carry a real announcement in a later sentence.
 */
function announcesAPlace(text: string): boolean {
  const clean = text.replace(EMPHASIS, "");
  SHAPE.lastIndex = 0;
  for (let m = SHAPE.exec(clean); m !== null; m = SHAPE.exec(clean)) {
    const [place = ""] = (m[2] ?? "").toLowerCase().split(/[\s,]+/);
    const zone = (m[3] ?? "").toLowerCase().split(/\s+/);
    if (place !== "" && !PLACE_STOP.has(bare(place)) && !zone.some((w) => ZONE_STOP.has(w))) {
      return true;
    }
    // Resume *inside* the rejected span rather than after it. A rejected match
    // swallows its own leading delimiter and place, so a clause boundary nested
    // in it is consumed with them -- "Also\nOmaha, Nebraska is in the Central
    // Time Zone" would never be tried. Advancing one character past the
    // delimiter both re-exposes that boundary and guarantees progress.
    SHAPE.lastIndex = m.index + (m[1] ?? "").length + 1;
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
