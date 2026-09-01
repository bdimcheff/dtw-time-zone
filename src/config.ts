/** Feed identity and collection configuration. */

/**
 * Hostname serving the DID document. This becomes the feed's permanent
 * identity — changing it orphans every subscriber, so it must not change.
 */
export const HOSTNAME = "dtw.dimcheff.wtf";

export const FEED_DID = `did:web:${HOSTNAME}`;

/**
 * Where the XRPC endpoints are actually served. Deliberately separate from
 * FEED_DID: a DID document's serviceEndpoint may point at a different host
 * (precedent: did:web:skyfeed.me serves from feeds.skyfeed.eu). Pagination did
 * not need it -- the skeleton became a function behind a Hosting rewrite on the
 * same host -- but it remains the escape hatch for moving the serving layer
 * elsewhere without changing the feed's identity.
 */
export const SERVICE_ENDPOINT = `https://${HOSTNAME}`;

/** Account whose repo holds the app.bsky.feed.generator record. */
export const PUBLISHER_HANDLE = "dimcheff.wtf";

/**
 * Resolved DID for PUBLISHER_HANDLE. Hardcoded rather than resolved at build
 * time so builds don't depend on the network; PLC DIDs are stable even when the
 * handle changes. publish-record.ts re-resolves and fails loudly on a mismatch.
 */
export const PUBLISHER_DID = "did:plc:2zwqewi6t7coiohtmpfzz2wd";

/** Record key; the feed's AT-URI is at://<publisher-did>/app.bsky.feed.generator/<key> */
export const FEED_RKEY = "dtw-time-zone";

/**
 * AT-URI of the app.bsky.feed.generator record clients subscribe to. Lives here
 * rather than in build.ts so the feed function can validate the `feed` query
 * param against it without importing build.ts, whose top-level await would pull
 * the whole data layer into the function bundle.
 */
export const FEED_URI = `at://${PUBLISHER_DID}/app.bsky.feed.generator/${FEED_RKEY}`;

export const FEED_NAME = "DTW Time Zone";
export const FEED_DESCRIPTION =
  "Detroit, Michigan is in the Eastern Time Zone.\n\n" +
  "Posts of the announcement that used to play on loop at DTW. " +
  "Updated a few times a day.";


export const USER_AGENT = `dtw-time-zone (+${SERVICE_ENDPOINT})`;

/**
 * The canonical phrase. Search ignores punctuation, so the comma and no-comma
 * spellings return identical result sets.
 */
export const EXACT_QUERIES = [
  '"Detroit, Michigan is in the Eastern Time Zone"',
  // classify() accepts the abbreviated spellings too, so they get a sweep of
  // their own rather than reaching the archive only as a variant a human has to
  // admit by hand.
  '"Detroit, MI is in the Eastern Time Zone"',
];

/**
 * Broader queries used to surface variants for manual review. Swept in full
 * every run, like the exact queries: they paginate through years of sincere
 * timezone discussion, but authenticated that is one request each bar the
 * Eastern query (two) and "Standard Time Zone" (four). See collect.ts.
 *
 * The Eastern query was once a list of four. Narrower variants ("… michigan",
 * "… detroit", "… dtw") existed only to work around the anonymous single-page
 * cap: each returned a different newest-100 window, so together they reached
 * posts the broad query could not. Authenticated, the broad query returns its
 * complete result set -- measured at 178 results across 2 pages, untruncated --
 * and the narrow ones contributed zero unique posts.
 *
 * The rest are for riffs that transplant the announcement somewhere else (#4).
 * classify() no longer requires the eastern frame, so unlike the list above
 * these are not redundant with each other: a phrase query is a literal
 * substring, and "Atlantic Standard Time Zone" does not contain "is in the
 * Atlantic Time Zone".
 *
 * Measured yields, against the archive as it stood when these were added:
 *
 *     "is in the Central Time Zone"     54 results, 21 new candidates
 *     "is in the Mountain Time Zone"    36 results, 18 new
 *     "is in the Pacific Time Zone"     27 results,  7 new
 *     "is in the Atlantic Time Zone"     7 results,  2 new
 *     "Standard Time Zone"             345 results,  2 new
 *     "Daylight Time Zone"              43 results,  1 new
 *
 * Deliberately absent, all measured rather than assumed:
 *
 * - "… Alaska …" and "… Hawaii …" return zero results. Not rare -- zero.
 * - "European Time Zone" returns 1182. That is not truncated -- MAX_PAGES
 *   allows 1200 -- but it spends the entire page budget, and every request of
 *   it, on one post, one page short of silently dropping results.
 * - "Turkey Time Zone", and every other single-country zone. The matcher
 *   accepts any zone name, so these only need a query if someone other than us
 *   posts one; the archive gains ~40 posts a year, and a query list that tries
 *   to enumerate the world's time zones will lose to it anyway. Add such a post
 *   by hand.
 */
export const VARIANT_QUERIES = [
  '"is in the Eastern Time Zone"',
  '"is in the Central Time Zone"',
  '"is in the Mountain Time Zone"',
  '"is in the Pacific Time Zone"',
  '"is in the Atlantic Time Zone"',
  // Not "<Zone> Time Zone" -- these catch "Atlantic Standard", "Pacific
  // Daylight" and anything else built the same way, in one query each.
  '"Standard Time Zone"',
  '"Daylight Time Zone"',
];
