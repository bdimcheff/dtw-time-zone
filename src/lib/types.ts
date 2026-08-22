/** A post captured by the collector. Keyed by `uri`. */
export interface StoredPost {
  /** AT-URI. Primary key, and the only field the feed skeleton actually needs. */
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  /** Retained for reclassification without re-querying, and for the future archive page. */
  text: string;
  createdAt: string;
  indexedAt: string;
  /** When this collector first saw the post. */
  firstSeenAt: string;
}

/** A post that matched loosely and needs a human decision before entering the feed. */
export interface PendingPost extends StoredPost {
  /** Which query surfaced it, for debugging the matchers. */
  matchedQuery: string;
}

export interface CollectorState {
  lastRunAt: string | null;
  lastFullSweepAt: string | null;
}

/** Shape of a post in an app.bsky.feed.searchPosts response. */
export interface SearchPostView {
  uri: string;
  cid: string;
  author: { did: string; handle: string };
  record: { text?: string; createdAt?: string };
  indexedAt: string;
}
