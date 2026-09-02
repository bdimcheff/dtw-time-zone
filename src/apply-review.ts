import { readFile } from "node:fs/promises";
import {
  readPosts,
  readPending,
  readDenied,
  writePosts,
  writePending,
  writeDenied,
} from "./lib/store.ts";
import type { StoredPost, PendingPost } from "./lib/types.ts";

/**
 * Applies one review session's decisions to `data/`. Driven by the
 * `review-queue` skill; no workflow runs this.
 *
 *   npm run apply-review -- decisions.json
 *
 * where decisions.json is `{ "admit": [uri, ...], "deny": [uri, ...] }`.
 *
 * Editing the three files by hand is still the documented route and still
 * works. This exists because a session decides dozens of posts at once and a
 * denial is two edits, only one of which is obvious: `corpus.test.ts` asserts
 * that nothing denied sits in the archive *or the queue*, so adding the `uri`
 * to `denied.json` without also deleting the entry from `pending.json` fails
 * the build.
 *
 * Only the queue is in scope. Denying a post that is already *archived* is a
 * different operation -- `denied.json` outranks an exact match, so it is the
 * one way to permanently remove a post -- and it stays a hand edit rather than
 * something a mistyped URI in this file can do by accident.
 */

interface Decisions {
  admit?: string[];
  deny?: string[];
}

function fail(message: string, uris: string[] = []): never {
  console.error(message);
  for (const uri of uris) console.error(`  ${uri}`);
  process.exit(1);
}

const decisionsPath = process.argv[2];
if (decisionsPath === undefined) {
  console.error("usage: npm run apply-review -- <decisions.json>");
  process.exit(2);
}

const decisions = JSON.parse(await readFile(decisionsPath, "utf8")) as Decisions;
const admit = new Set(decisions.admit ?? []);
const deny = new Set(decisions.deny ?? []);

const both = [...admit].filter((uri) => deny.has(uri));
if (both.length > 0) {
  fail(`${both.length} URI(s) appear in both admit and deny:`, both);
}

const [posts, pending, denied] = await Promise.all([readPosts(), readPending(), readDenied()]);

/**
 * Decisions name posts by `uri`, never by position. A review session outlives a
 * collection -- update.yml rewrites data/pending.json every thirty minutes --
 * so an index read at the start of a session can name a different post by the
 * time the session ends.
 *
 * A URI that is no longer queued is therefore a real signal, not noise: either
 * the queue moved underneath the session or the URI is wrong. Applying the rest
 * and staying quiet would drop a decision a human actually made, so refuse the
 * whole file and let the session re-read the queue.
 */
const queued = new Set(pending.map((p) => p.uri));
const missing = [...admit, ...deny].filter((uri) => !queued.has(uri));
if (missing.length > 0) {
  fail(
    `${missing.length} URI(s) are not in the review queue -- re-read ` +
      "data/pending.json and rebuild the decisions:",
    missing,
  );
}

/**
 * `matchedQuery` records how the collector found a post, not anything about the
 * post, and `StoredPost` has no such field. Dropping it on admission keeps an
 * admitted post the same shape as a collected one; every entry in posts.json
 * carries exactly StoredPost's fields today.
 */
const promote = ({ matchedQuery, ...post }: PendingPost): StoredPost => post;

const admitted = pending.filter((p) => admit.has(p.uri)).map(promote);
const remaining = pending.filter((p) => !admit.has(p.uri) && !deny.has(p.uri));

await writePosts([...posts, ...admitted]);
await writePending(remaining);
await writeDenied([...denied, ...deny]);

console.log(
  `Admitted ${admitted.length}, denied ${deny.size}. ` +
    `Archive ${posts.length} -> ${posts.length + admitted.length}, ` +
    `queue ${pending.length} -> ${remaining.length}, ` +
    `denied ${denied.size} -> ${new Set([...denied, ...deny]).size}.`,
);
