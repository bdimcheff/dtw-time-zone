import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planReview, ReviewError } from "./review.ts";
import type { PendingPost } from "./types.ts";

/**
 * apply-review.ts is the only script here that makes a permanent, retroactive
 * change -- denied.json outranks an exact match and there is no undo -- so its
 * refusals are asserted rather than trusted. Every case below is a decisions file
 * that must not be applied as written; the queue it would have damaged is the
 * same one each time.
 */

const post = (uri: string): PendingPost => ({
  uri,
  cid: `cid:${uri}`,
  authorDid: "did:plc:author",
  authorHandle: "author.example",
  text: `text of ${uri}`,
  createdAt: "2025-01-01T00:00:00.000Z",
  indexedAt: "2025-01-01T00:00:01.000Z",
  firstSeenAt: "2025-01-02T00:00:00.000Z",
  matchedQuery: '"is in the Eastern Time Zone"',
});

const QUEUE = [post("at://a"), post("at://b"), post("at://c")];
const NO_DENIALS: ReadonlySet<string> = new Set();

/** Asserts the call refuses, and that it names the URIs at fault. */
const refuses = (decisions: unknown, uris: string[] = [], denied = NO_DENIALS) => {
  assert.throws(
    () => planReview(decisions, QUEUE, denied),
    (err: unknown) => {
      assert.ok(err instanceof ReviewError, `expected ReviewError, got ${err}`);
      assert.deepEqual(err.uris, uris);
      return true;
    },
  );
};

describe("planReview", () => {
  test("splits the queue into admitted, remaining and denied", () => {
    const plan = planReview({ admit: ["at://a"], deny: ["at://b"] }, QUEUE, NO_DENIALS);
    assert.deepEqual(plan.admitted.map((p) => p.uri), ["at://a"]);
    assert.deepEqual(plan.remaining.map((p) => p.uri), ["at://c"]);
    assert.deepEqual(plan.denied, ["at://b"]);
  });

  test("an admitted post keeps every field but matchedQuery", () => {
    // posts.json entries carry exactly StoredPost's keys; matchedQuery records
    // how the collector found the post, not anything about it.
    const plan = planReview({ admit: ["at://a"] }, QUEUE, NO_DENIALS);
    const { matchedQuery, ...expected } = QUEUE[0]!;
    assert.deepEqual(plan.admitted[0], expected);
    assert.ok(!("matchedQuery" in plan.admitted[0]!));
  });

  test("a denial both leaves the queue and joins denied.json", () => {
    // corpus.test.ts asserts nothing denied sits in the archive *or* the queue,
    // so half of this is what a hand edit forgets.
    const plan = planReview({ deny: ["at://b"] }, QUEUE, new Set(["at://old"]));
    assert.deepEqual(plan.remaining.map((p) => p.uri), ["at://a", "at://c"]);
    assert.deepEqual(plan.denied, ["at://old", "at://b"]);
  });

  test("empty decisions change nothing", () => {
    const plan = planReview({}, QUEUE, NO_DENIALS);
    assert.deepEqual(plan.admitted, []);
    assert.deepEqual(plan.remaining, QUEUE);
    assert.deepEqual(plan.denied, []);
  });

  test("refuses an unrecognised key", () => {
    // The quietest failure available: "admits" would apply nothing, exit 0, and
    // leave the queue holding posts the reviewer had already decided.
    refuses({ admits: ["at://a"] }, ["admits"]);
    refuses({ admit: ["at://a"], denied: ["at://b"] }, ["denied"]);
  });

  test("refuses a value that is not a list of URIs", () => {
    refuses({ admit: "at://a" });
    refuses({ deny: [1, 2] });
  });

  test("refuses anything that is not an object of decisions", () => {
    refuses(["at://a"]);
    refuses(null);
    refuses("at://a");
  });

  test("refuses a URI decided both ways", () => {
    refuses({ admit: ["at://a"], deny: ["at://a"] }, ["at://a"]);
  });

  test("refuses a URI that is no longer queued", () => {
    // What a collection landing mid-session looks like. Applying the rest would
    // drop a decision a human made, with nothing to say so.
    refuses({ admit: ["at://a"], deny: ["at://gone"] }, ["at://gone"]);
  });

  test("refuses admitting a URI that is already denied", () => {
    // Reachable from the hand-edit route: a uri appended to denied.json without
    // the queue entry deleted. The admission would look like it worked, then
    // vanish at the next collection, when collect.ts applies denied.json at load.
    refuses({ admit: ["at://a"] }, ["at://a"], new Set(["at://a"]));
  });

  test("does not mutate the queue it was given", () => {
    const before = structuredClone(QUEUE);
    planReview({ admit: ["at://a"], deny: ["at://b"] }, QUEUE, NO_DENIALS);
    assert.deepEqual(QUEUE, before);
  });
});
