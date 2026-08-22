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
 * (precedent: did:web:skyfeed.me serves from feeds.skyfeed.eu). This is the
 * escape hatch for moving off static hosting once the feed outgrows the
 * single-page limit, without changing the feed's identity.
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

export const FEED_NAME = "DTW Time Zone";
export const FEED_DESCRIPTION =
  "Detroit, Michigan is in the Eastern Time Zone.\n\n" +
  "Posts of the announcement that used to play on loop at DTW. " +
  "Updated a few times a day.";

/**
 * searchPosts is blocked at the CDN on public.api.bsky.app but serves
 * unauthenticated on api.bsky.app. See PLAN.md.
 */
export const APPVIEW = "https://api.bsky.app";

export const USER_AGENT = `dtw-time-zone (+${SERVICE_ENDPOINT})`;

/**
 * The canonical phrase, normalized. Search ignores punctuation, so the
 * comma and no-comma spellings return identical result sets.
 */
export const EXACT_QUERY = '"Detroit, Michigan is in the Eastern Time Zone"';

/**
 * Broader queries used to surface variants for manual review. These paginate
 * through years of sincere timezone discussion, so they run windowed rather
 * than as full sweeps. See collect.ts.
 *
 * The narrower queries look redundant — classify() only accepts a variant if it
 * contains the frame, which the first query searches for directly — but that
 * holds only for an unbounded search. Each query hits the single-page cap and
 * returns a different newest-100 window, so the narrow ones reach posts the
 * broad one cannot. Measured unauthenticated: "detroit" contributed 27 relevant
 * posts and "dtw" 2 that the broad query alone missed. "michigan" contributed
 * none at that moment, and is kept because the balance shifts once
 * authentication lifts the cap.
 */
export const VARIANT_QUERIES = [
  '"is in the Eastern Time Zone"',
  '"eastern time zone" michigan',
  '"eastern time zone" detroit',
  '"eastern time zone" dtw',
];

/**
 * Number of posts served in the feed skeleton. Static hosting cannot read the
 * cursor query param, so the feed is a single page. The full archive lives in
 * data/posts.json regardless.
 */
export const FEED_LIMIT = 100;

/**
 * Overlap applied to the `since` window on variant queries. since/until filter
 * on `sortAt`, which the lexicon warns may not match `createdAt`, so the window
 * is widened rather than trusted exactly. Dedupe by URI makes overlap free.
 */
export const WINDOW_OVERLAP_DAYS = 7;

/** Days between full (unwindowed) variant sweeps. */
export const FULL_SWEEP_INTERVAL_DAYS = 30;
