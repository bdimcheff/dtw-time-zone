import type { StoredPost, PendingPost } from "./types.ts";

/**
 * The decision half of a review session, kept apart from the file I/O so that it
 * can be tested. `apply-review.ts` reads the three data files, calls `planReview`,
 * and writes what comes back.
 *
 * Everything here refuses rather than repairs. A decisions file is small,
 * hand-built, and applied to an archive whose denials are permanent, so the
 * useful failure is the loud one: a session that has to re-read the queue and try
 * again has lost a minute, while one that half-applies has lost a decision a
 * human made and says nothing.
 */

/** A decisions file: `{ "admit": [uri, ...], "deny": [uri, ...] }`. */
export interface Decisions {
  admit?: string[];
  deny?: string[];
}

/** What the three data files should become. */
export interface ReviewPlan {
  /** Appended to data/posts.json. */
  admitted: StoredPost[];
  /** The whole of the new data/pending.json. */
  remaining: PendingPost[];
  /** The whole of the new data/denied.json. */
  denied: string[];
}

/** A decisions file that cannot be applied as written, with the URIs at fault. */
export class ReviewError extends Error {
  constructor(message: string, readonly uris: string[] = []) {
    super(message);
    this.name = "ReviewError";
  }
}

const DECISION_KEYS = ["admit", "deny"];

/**
 * `matchedQuery` records how the collector found a post, not anything about the
 * post, and `StoredPost` has no such field. Dropping it on admission keeps an
 * admitted post the same shape as a collected one; every entry in posts.json
 * carries exactly StoredPost's fields today.
 */
const promote = ({ matchedQuery, ...post }: PendingPost): StoredPost => post;

function uriList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ReviewError(`"${key}" must be an array of URI strings`);
  }
  return value as string[];
}

export function planReview(
  decisions: unknown,
  pending: PendingPost[],
  denied: ReadonlySet<string>,
): ReviewPlan {
  if (typeof decisions !== "object" || decisions === null || Array.isArray(decisions)) {
    throw new ReviewError('the decisions file must be an object with "admit" and/or "deny"');
  }

  /**
   * An unrecognised key is a typo, and a typo read past is the quietest failure
   * this file has: `"admits"` applies nothing, exits 0, and leaves `npm run
   * check` green, with the only symptom a queue that still holds posts the
   * reviewer already decided. Nothing later notices, because nothing later knows
   * a decision was made.
   */
  const record = decisions as Record<string, unknown>;
  const unrecognised = Object.keys(record).filter((k) => !DECISION_KEYS.includes(k));
  if (unrecognised.length > 0) {
    throw new ReviewError(
      'unrecognised key(s) in the decisions file — only "admit" and "deny" are read:',
      unrecognised,
    );
  }

  const admit = new Set(uriList(record["admit"], "admit"));
  const deny = new Set(uriList(record["deny"], "deny"));

  const both = [...admit].filter((uri) => deny.has(uri));
  if (both.length > 0) {
    throw new ReviewError("URI(s) appear in both admit and deny:", both);
  }

  /**
   * Decisions name posts by `uri`, never by position. A review session outlives a
   * collection — update.yml rewrites data/pending.json every thirty minutes — so
   * an index read at the start of a session can name a different post by the time
   * the session ends.
   *
   * A URI that is no longer queued is therefore a real signal: either the queue
   * moved underneath the session or the URI is wrong.
   */
  const queued = new Set(pending.map((p) => p.uri));
  const missing = [...admit, ...deny].filter((uri) => !queued.has(uri));
  if (missing.length > 0) {
    throw new ReviewError(
      "URI(s) are not in the review queue — re-read data/pending.json and rebuild " +
        "the decisions:",
      missing,
    );
  }

  /**
   * Admitting something already denied looks like it worked and then undoes
   * itself: collect.ts applies denied.json at load, so the next collection
   * deletes the post from posts.json again, with no diff to explain it. It is
   * reachable from the hand-edit route this script exists to replace — appending
   * a `uri` to denied.json without also deleting the queue entry leaves exactly
   * this state for the next session to walk into.
   */
  const revoked = [...admit].filter((uri) => denied.has(uri));
  if (revoked.length > 0) {
    throw new ReviewError(
      "URI(s) are already in denied.json, so admitting them would not survive the " +
        "next collection:",
      revoked,
    );
  }

  return {
    admitted: pending.filter((p) => admit.has(p.uri)).map(promote),
    remaining: pending.filter((p) => !admit.has(p.uri) && !deny.has(p.uri)),
    denied: [...denied, ...deny],
  };
}
