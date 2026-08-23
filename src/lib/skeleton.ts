import type { FeedEntry } from "./order.ts";

/**
 * Pagination for app.bsky.feed.getFeedSkeleton.
 *
 * The AppView is unforgiving here in ways that produce no error, only a short
 * feed (packages/bsky/src/api/app/bsky/feed/getFeed.ts):
 *
 *   const feedItems = feedSkele.slice(0, params.limit)
 *   cursor: feedSkele.length === 0 || cursor === params.cursor ? undefined : cursor
 *
 * So: never return more than `limit` entries (the slice happens before our cursor
 * is read, and anything past it is dropped without being paged to), never return
 * an empty page while entries remain, and never echo the request's cursor.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface Page {
  feed: { post: string }[];
  cursor?: string;
}

/** Thrown for a cursor we cannot trust; the caller maps this to InvalidRequest. */
export class BadCursor extends Error {}

/**
 * A cursor is a position in the feed's total order, not an offset. That is what
 * makes a walk stable while the archive changes underneath it: review admissions
 * backfill into the middle of the order, and an offset would skip or repeat
 * across them. It also means a cursor stays valid after its own post is denied —
 * the key is compared against the list, never looked up in it.
 */
export const encodeCursor = (e: FeedEntry): string =>
  Buffer.from(`${e.sortAt}:${e.uri}`, "utf8").toString("base64url");

export function decodeCursor(raw: string): FeedEntry {
  let decoded: string;
  try {
    // base64url is what we emit; plain base64 also decodes, in case anything in
    // the path re-encodes it.
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new BadCursor("cursor is not valid base64url");
  }

  // indexOf, never split(":"): an AT-URI is at://did:plc:…, so splitting yields
  // "at" as the uri. Since "at" < "at://…" that parse makes the cursor's own post
  // satisfy strictly-after, and every page silently repeats its last entry.
  const sep = decoded.indexOf(":");
  if (sep === -1) throw new BadCursor("cursor is malformed");

  const sortAt = Number(decoded.slice(0, sep));
  const uri = decoded.slice(sep + 1);

  // A NaN here would make every comparison false rather than throwing, which
  // reads downstream as an empty or a full page rather than as a bad request.
  if (!Number.isInteger(sortAt)) throw new BadCursor("cursor has a bad sort key");
  if (!uri.startsWith("at://")) throw new BadCursor("cursor has a bad uri");

  return { uri, sortAt };
}

/** Clamped, never rejected: only a non-AppView caller can be out of range. */
export function clampLimit(raw: string | undefined): number {
  // Number("") is 0, not NaN, so an absent-but-present `limit=` would clamp to 1
  // and serve one post per page rather than falling back to the default.
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * `entries` must already be in byNewest order. Returns at most `limit` entries
 * strictly after `cursor`, and a cursor only when entries remain beyond them.
 */
export function paginate(
  entries: FeedEntry[],
  opts: { limit?: string; cursor?: string } = {},
): Page {
  const limit = clampLimit(opts.limit);

  let start = 0;
  if (opts.cursor !== undefined && opts.cursor !== "") {
    const key = decodeCursor(opts.cursor);
    // Descending sortAt, ascending uri — the same total order as byNewest. Get
    // the second leg backwards and a page boundary inside a run of equal
    // timestamps drops the rest of that run.
    start = entries.findIndex(
      (e) => e.sortAt < key.sortAt || (e.sortAt === key.sortAt && e.uri > key.uri),
    );
    // Cursor past the end: an empty page with no cursor is the one correct way
    // to say "end of feed".
    if (start === -1) return { feed: [] };
  }

  const page = entries.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + page.length < entries.length;

  return {
    feed: page.map((e) => ({ post: e.uri })),
    // Derived from the last entry returned, so it can never equal the request's
    // cursor. Omitted on the final page, including an exactly-full one.
    ...(more && last ? { cursor: encodeCursor(last) } : {}),
  };
}
