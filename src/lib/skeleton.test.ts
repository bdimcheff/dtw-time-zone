import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BadCursor, DEFAULT_LIMIT, clampLimit, decodeCursor, encodeCursor, paginate,
} from "./skeleton.ts";
import type { FeedEntry } from "./order.ts";

/**
 * Fixtures, not the corpus. Every interesting case here is one the archive
 * cannot produce — it has no sortAt ties and nobody hands it a malformed
 * cursor — so a test against committed data would assert nothing.
 * corpus.test.ts covers the walk over real data.
 */

const at = (n: number) => `at://did:plc:2zwqewi6t7coiohtmpfzz2wd/app.bsky.feed.post/3l${n}`;

/** n entries, newest first, one millisecond apart. */
const feed = (n: number): FeedEntry[] =>
  Array.from({ length: n }, (_, i) => ({ uri: at(i), sortAt: 1_000_000 - i }));

const uris = (p: { feed: { post: string }[] }) => p.feed.map((f) => f.post);

/** Walk to exhaustion, returning every uri seen and the number of pages taken. */
function walk(entries: FeedEntry[], limit: string, cap = 100) {
  const seen: string[] = [];
  const cursors: (string | undefined)[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = paginate(entries, { limit, cursor });
    pages++;
    // The AppView reads an echoed cursor as end-of-feed, so this must hold on
    // every page of every walk, not just at the boundaries.
    assert.notEqual(page.cursor, cursor, `page ${pages} echoed its request cursor`);
    seen.push(...uris(page));
    cursors.push(page.cursor);
    if (page.cursor === undefined) break;
    cursor = page.cursor;
    assert.ok(pages < cap, "walk did not terminate");
  }
  return { seen, pages, cursors };
}

describe("cursor encoding", () => {
  test("round-trips an entry", () => {
    const e = { uri: at(7), sortAt: 1_724_400_000_000 };
    assert.deepEqual(decodeCursor(encodeCursor(e)), e);
  });

  test("survives the colons in an AT-URI", () => {
    // split(":") would yield "at" here, and because "at" sorts before "at://…"
    // the cursor's own post would satisfy strictly-after: every page would
    // repeat its last entry, looking exactly like an off-by-one.
    const e = { uri: at(1), sortAt: 5 };
    assert.equal(decodeCursor(encodeCursor(e)).uri, e.uri);
  });

  test("accepts standard base64 as well as base64url", () => {
    const e = { uri: at(2), sortAt: 1_724_400_000_000 };
    const std = Buffer.from(`${e.sortAt}:${e.uri}`, "utf8").toString("base64");
    assert.deepEqual(decodeCursor(std), e);
  });

  for (const [label, raw] of [
    ["not base64 at all", "!!!!"],
    ["no separator", Buffer.from("nope", "utf8").toString("base64url")],
    ["non-integer sort key", Buffer.from(`abc:${at(1)}`, "utf8").toString("base64url")],
    ["uri that is not an at-uri", Buffer.from("123:https://example.com", "utf8").toString("base64url")],
  ] as const) {
    test(`rejects a cursor with ${label}`, () => {
      // NaN would compare false against everything rather than throwing, which
      // surfaces as a silently empty or silently full page.
      assert.throws(() => decodeCursor(raw), BadCursor);
    });
  }
});

describe("limit", () => {
  test("defaults when absent or unparseable", () => {
    for (const raw of [undefined, "", "abc"]) {
      assert.equal(clampLimit(raw), DEFAULT_LIMIT, String(raw));
    }
  });

  test("clamps to 1-100", () => {
    assert.equal(clampLimit("0"), 1);
    assert.equal(clampLimit("-1"), 1);
    assert.equal(clampLimit("101"), 100);
    assert.equal(clampLimit("50"), 50);
  });

  test("never returns more entries than asked for", () => {
    // getFeed slices to params.limit *before* reading our cursor, so an oversized
    // page drops posts on the floor without paging to them.
    for (const limit of ["1", "7", "101"]) {
      const page = paginate(feed(200), { limit });
      assert.ok(page.feed.length <= 100, limit);
      assert.ok(page.feed.length <= clampLimit(limit), limit);
    }
  });
});

describe("paginate", () => {
  test("an empty archive is one empty page with no cursor", () => {
    assert.deepEqual(paginate([], {}), { feed: [] });
  });

  test("a full walk yields every entry once, in order", () => {
    const entries = feed(88);
    const { seen, pages } = walk(entries, "10");
    assert.deepEqual(seen, entries.map((e) => e.uri));
    assert.equal(new Set(seen).size, seen.length, "no repeats");
    assert.equal(pages, 9);
  });

  test("an exactly-full final page returns no cursor", () => {
    // Otherwise the next request returns an empty page, which the AppView reads
    // as end-of-feed anyway — but only after a wasted round trip.
    const { pages, cursors } = walk(feed(20), "10");
    assert.equal(pages, 2);
    assert.equal(cursors.at(-1), undefined);
  });

  test("a page boundary inside a run of equal sortAt keeps the run intact", () => {
    // The only case that catches a reversed tiebreaker. The corpus has no ties,
    // so nothing else in the suite would notice.
    const tied: FeedEntry[] = [0, 1, 2, 3, 4].map((i) => ({ uri: at(i), sortAt: 999 }));
    const { seen } = walk(tied, "2");
    assert.deepEqual(seen, tied.map((e) => e.uri));
  });

  test("a cursor whose entry has since been denied still resolves", () => {
    const entries = feed(10);
    const cursor = encodeCursor(entries[4]!);
    const without = entries.filter((e) => e.uri !== entries[4]!.uri);
    assert.deepEqual(uris(paginate(without, { limit: "3", cursor })), [
      entries[5]!.uri, entries[6]!.uri, entries[7]!.uri,
    ]);
  });

  test("a post admitted mid-walk is neither repeated nor duplicated", () => {
    // Review admissions backfill into the middle of the order, so this is the
    // normal case here, not an edge case. The inserted post is simply not seen
    // on this walk; it appears on the next one.
    const entries = feed(10);
    const cursor = encodeCursor(entries[4]!);
    const inserted: FeedEntry = { uri: at(99), sortAt: entries[2]!.sortAt - 1 };
    const after = [...entries.slice(0, 3), inserted, ...entries.slice(3)];
    const page = paginate(after, { limit: "5", cursor });
    assert.ok(!uris(page).includes(inserted.uri), "backfilled post is behind the cursor");
    assert.deepEqual(uris(page), entries.slice(5).map((e) => e.uri));
  });

  test("a cursor past the end is an empty page with no cursor", () => {
    const entries = feed(5);
    const cursor = encodeCursor({ uri: at(0), sortAt: 0 });
    assert.deepEqual(paginate(entries, { cursor }), { feed: [] });
  });

  test("a cursor newer than everything returns the whole feed", () => {
    const entries = feed(5);
    const cursor = encodeCursor({ uri: at(0), sortAt: 9_999_999 });
    assert.deepEqual(uris(paginate(entries, { cursor })), entries.map((e) => e.uri));
  });
});
