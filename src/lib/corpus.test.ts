import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./match.ts";
import { entriesOf, sortAt, byNewest } from "./order.ts";
import { paginate } from "./skeleton.ts";
import { readPending, readPosts, readDenied } from "./store.ts";

/**
 * Invariants over the committed data. These run against whatever the collector
 * last wrote, so they guard the matcher and the store against changes that look
 * fine in isolation but would quietly reshape the archive.
 */

const posts = await readPosts();
const pending = await readPending();
const denied = await readDenied();

describe("archive", () => {
  test("is not empty", () => {
    assert.ok(posts.length > 0, "data/posts.json should not be empty");
  });

  test("every archived post still matches", () => {
    // A matcher change that drops an archived post is a silent regression: the
    // post stays in the file but nothing would re-add it if it were ever lost.
    const dropped = posts.filter((p) => classify(p.text) === "ignore");
    assert.deepEqual(dropped.map((p) => p.text.slice(0, 60)), []);
  });

  test("URIs are unique", () => {
    // Load-bearing for pagination as well as for the archive: the feed cursor
    // encodes (sortAt, uri) as a position in a total order, and duplicate URIs
    // would make that order non-total at a tie.
    assert.equal(new Set(posts.map((p) => p.uri)).size, posts.length);
  });

  test("nothing denied is in the archive or the queue", () => {
    assert.deepEqual(posts.filter((p) => denied.has(p.uri)).map((p) => p.uri), []);
    assert.deepEqual(pending.filter((p) => denied.has(p.uri)).map((p) => p.uri), []);
  });

  test("a paginated walk reaches every archived post exactly once", () => {
    // The endpoint's contract, asserted against the real archive: subscribers
    // see the whole thing only if a cursor walk is a permutation of it. limit=7
    // is deliberately not a divisor of the corpus size, so the final page is a
    // partial one.
    const entries = entriesOf(posts);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const cap = Math.ceil(entries.length / 7) + 3;
    for (;;) {
      const page = paginate(entries, { limit: "7", cursor });
      pages++;
      assert.notEqual(page.cursor, cursor, `page ${pages} echoed its request cursor`);
      assert.ok(page.feed.length <= 7, "page exceeded the requested limit");
      seen.push(...page.feed.map((f) => f.post));
      if (page.cursor === undefined) break;
      cursor = page.cursor;
      assert.ok(pages <= cap, "walk did not terminate");
    }
    assert.deepEqual(seen, entries.map((e) => e.uri), "walk order matches byNewest");
    assert.equal(new Set(seen).size, seen.length, "no post appears twice");
    assert.equal(pages, Math.ceil(entries.length / 7), "no wasted trailing page");
  });

  // Deliberately not asserted: file order. The documented way to admit a post is
  // to move its entry into data/posts.json, which does not produce sorted output,
  // and enforcing order on pull requests would fail reviewers for following the
  // instructions. Nothing depends on it -- writePosts sorts on every write and
  // build.ts sorts again before rendering.
});

describe("review queue", () => {
  test("holds no post the matcher would auto-admit", () => {
    // collect.ts promotes these on load. Anything left here means promotion did
    // not run, and the post sits in the queue misreported as awaiting a human
    // decision it does not need.
    const promotable = pending.filter((p) => classify(p.text) === "exact");
    assert.deepEqual(promotable.map((p) => p.text.slice(0, 60)), []);
  });

  test("holds nothing already archived", () => {
    const archived = new Set(posts.map((p) => p.uri));
    assert.deepEqual(pending.filter((p) => archived.has(p.uri)).map((p) => p.uri), []);
  });

  test("every queued post is a variant", () => {
    const wrong = pending.filter((p) => classify(p.text) !== "variant");
    assert.deepEqual(wrong.map((p) => p.text.slice(0, 60)), []);
  });
});

describe("sort key", () => {
  const at = (createdAt: string, indexedAt: string) =>
    sortAt({ createdAt, indexedAt } as Parameters<typeof sortAt>[0]);

  test("prefers createdAt when it precedes indexing", () => {
    assert.equal(at("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:05.000Z"), "2025-01-01T00:00:00.000Z");
  });

  test("caps a post-dated createdAt at indexedAt", () => {
    // createdAt is client-supplied; without this, a future date pins a post to
    // the top of the feed permanently.
    assert.equal(at("2099-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"), "2025-01-01T00:00:00.000Z");
  });

  test("keeps a genuinely backdated post at its own date", () => {
    // A real archived post is dated 2009, years before Bluesky, from an import.
    assert.equal(at("2009-10-16T17:25:46.000Z", "2024-11-11T20:40:46.000Z"), "2009-10-16T17:25:46.000Z");
  });

  test("compares by instant, not by string", () => {
    // A client-supplied offset sorts wrong lexicographically against a
    // Z-normalized indexedAt, though both name the same moment.
    // 00:30-05:00 is 05:30Z, so it is the newer of the two and must sort first.
    // As strings the opposite holds: "T00:30" precedes "T05:00", which would
    // place it last.
    const withOffset = { createdAt: "2025-06-01T00:30:00-05:00", indexedAt: "2025-06-01T06:00:00.000Z" } as any;
    const utc = { createdAt: "2025-06-01T05:00:00.000Z", indexedAt: "2025-06-01T06:00:00.000Z" } as any;
    assert.ok(byNewest(withOffset, utc) < 0, "05:30Z should sort ahead of 05:00Z");
    assert.ok(
      sortAt(withOffset).localeCompare(sortAt(utc)) < 0,
      "guard: the string ordering really is the opposite, so this test has teeth",
    );
  });

  test("orders newest first", () => {
    const older = { createdAt: "2024-01-01T00:00:00.000Z", indexedAt: "2024-01-01T00:00:00.000Z" } as any;
    const newer = { createdAt: "2026-01-01T00:00:00.000Z", indexedAt: "2026-01-01T00:00:00.000Z" } as any;
    assert.ok(byNewest(newer, older) < 0);
  });
});
