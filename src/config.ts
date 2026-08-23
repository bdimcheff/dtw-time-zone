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

/**
 * searchPosts is blocked at the CDN on public.api.bsky.app but serves
 * unauthenticated on api.bsky.app. See PLAN.md.
 */
export const APPVIEW = "https://api.bsky.app";

export const USER_AGENT = `dtw-time-zone (+${SERVICE_ENDPOINT})`;

/**
 * The canonical phrase. Search ignores punctuation, so the comma and no-comma
 * spellings return identical result sets.
 */
export const EXACT_QUERIES = [
  '"Detroit, Michigan is in the Eastern Time Zone"',
  // classify() accepts the abbreviated spellings too, so they get the same
  // unwindowed sweep. Without this they arrive only via the windowed variant
  // query, which would miss an older post outside the window until the next full
  // sweep.
  '"Detroit, MI is in the Eastern Time Zone"',
];

/**
 * Broader query used to surface variants for manual review. It paginates through
 * years of sincere timezone discussion, so it runs windowed rather than as a full
 * sweep. See collect.ts.
 *
 * This was once a list of four. Narrower variants ("… michigan", "… detroit",
 * "… dtw") existed only to work around the anonymous single-page cap: each
 * returned a different newest-100 window, so together they reached posts the
 * broad query could not. Authenticated, the broad query returns its complete
 * result set — measured at 170 results across 2 pages, untruncated — and the
 * narrow ones contributed zero unique posts. classify() only accepts a variant
 * containing the frame this query searches for, so the broad query is now a
 * strict superset.
 */
export const VARIANT_QUERIES = ['"is in the Eastern Time Zone"'];

/**
 * Entries written to the skeleton. The AppView slices this to the client's own
 * limit, which caps at 100, so serving more would never reach anyone.
 *
 * Retires with the static skeleton when the paginating endpoint lands (#2).
 */
export const FEED_LIMIT = 100;
