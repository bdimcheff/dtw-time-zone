import { readFile } from "node:fs/promises";
import {
  readPosts,
  readPending,
  readDenied,
  writePosts,
  writePending,
  writeDenied,
} from "./lib/store.ts";
import { planReview, ReviewError } from "./lib/review.ts";
import type { ReviewPlan } from "./lib/review.ts";

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
 * different operation — `denied.json` outranks an exact match, so it is the one
 * way to permanently remove a post — and it stays a hand edit rather than
 * something a mistyped URI in this file can do by accident.
 *
 * The decisions themselves are planned in `lib/review.ts`, which is where the
 * refusals and their reasoning live.
 */

const decisionsPath = process.argv[2];
if (decisionsPath === undefined) {
  console.error("usage: npm run apply-review -- <decisions.json>");
  process.exit(2);
}

const [posts, pending, denied] = await Promise.all([readPosts(), readPending(), readDenied()]);

let plan: ReviewPlan;
try {
  plan = planReview(JSON.parse(await readFile(decisionsPath, "utf8")), pending, denied);
} catch (err) {
  if (!(err instanceof ReviewError)) throw err;
  console.error(err.message);
  for (const uri of err.uris) console.error(`  ${uri}`);
  process.exit(1);
}

await writePosts([...posts, ...plan.admitted]);
await writePending(plan.remaining);
await writeDenied(plan.denied);

console.log(
  `Admitted ${plan.admitted.length}, denied ${plan.denied.length - denied.size}. ` +
    `Archive ${posts.length} -> ${posts.length + plan.admitted.length}, ` +
    `queue ${pending.length} -> ${plan.remaining.length}, ` +
    `denied ${denied.size} -> ${new Set(plan.denied).size}.`,
);
