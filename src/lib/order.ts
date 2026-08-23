import type { StoredPost } from "./types.ts";

/**
 * The feed's total order, and the sort key the pagination cursor encodes.
 *
 * Split out of store.ts because the feed function bundles this module: store.ts
 * reaches for node:fs, which has no business inside a request handler.
 */

/** The fields ordering actually needs. StoredPost satisfies this structurally. */
export interface Orderable {
  uri: string;
  createdAt: string;
  indexedAt: string;
}

/**
 * `createdAt` is client-supplied and unverified: the archive already contains a
 * post dated 2009, years before Bluesky existed. Sorting on it alone would let
 * anyone pin themselves to the top of the feed forever by posting a future date.
 * Taking the earlier of createdAt and indexedAt caps a post at the moment the
 * network actually saw it, which is how the AppView derives its own sort key.
 */
export const sortAt = (p: Orderable): string =>
  ms(p.createdAt) < ms(p.indexedAt) ? p.createdAt : p.indexedAt;

/**
 * Milliseconds for an ISO timestamp. These are compared numerically rather than
 * lexicographically because `createdAt` is client-supplied: it may carry a UTC
 * offset ("…T00:30:00-05:00") or omit milliseconds, either of which sorts wrong
 * as a string against the Z-normalized `indexedAt`. An unparseable value pins to
 * the epoch, which puts a malformed record at the bottom of the feed instead of
 * making the comparator non-transitive with NaN.
 */
export const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Newest first, so the feed skeleton is a prefix of this array.
 *
 * The `uri` tiebreaker is load-bearing for pagination, not cosmetic: the cursor
 * encodes a position in this order, so two posts sharing a `sortAt` millisecond
 * need a defined order or a walk lands mid-tie and skips or repeats the rest of
 * the run. The corpus has no ties today; this is what keeps that from mattering.
 *
 * Compared with < and > rather than localeCompare, which is ICU- and
 * locale-dependent: build.ts sorts on a GitHub runner and the feed function
 * compares inside a Cloud Functions container. Disagreement between them would
 * silently drop posts from a walk. Totality also depends on URIs being unique,
 * which corpus.test.ts asserts.
 */
export const byNewest = (a: Orderable, b: Orderable) =>
  ms(sortAt(b)) - ms(sortAt(a)) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);

/** A post reduced to what the feed endpoint serves and orders by. */
export interface FeedEntry {
  uri: string;
  /** sortAt as epoch milliseconds; the cursor's first component. */
  sortAt: number;
}

export const toEntry = (p: Orderable): FeedEntry => ({
  uri: p.uri,
  sortAt: ms(sortAt(p)),
});

/** Typed narrowly so callers can pass StoredPost without a cast. */
export const entriesOf = (posts: StoredPost[]): FeedEntry[] =>
  [...posts].sort(byNewest).map(toEntry);
