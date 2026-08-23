import { EXACT_QUERIES, VARIANT_QUERIES } from "./config.ts";
import { createSearcher, exitOnConfigError } from "./lib/bsky.ts";
import type { Searcher } from "./lib/bsky.ts";
import { classify, postText } from "./lib/match.ts";
import { readPosts, readPending, readDenied, writePosts, writePending } from "./lib/store.ts";
import type { StoredPost, SearchPostView } from "./lib/types.ts";

function toStored(p: SearchPostView, firstSeenAt: string): StoredPost {
  return {
    uri: p.uri,
    cid: p.cid,
    authorDid: p.author.did,
    authorHandle: p.author.handle,
    text: postText(p),
    createdAt: p.record?.createdAt ?? p.indexedAt,
    indexedAt: p.indexedAt,
    firstSeenAt,
  };
}

/**
 * One failing query must not discard the rest of the run. Every query completes
 * before anything is written, so an unguarded throw from the last query threw
 * away the others' results too, then failed the workflow before Build and Deploy.
 */
async function runQuery(search: Searcher, query: string): Promise<SearchPostView[]> {
  try {
    return await search(query);
  } catch (err) {
    console.error(`  query failed: ${query}\n    ${(err as Error).message}`);
    return [];
  }
}


const nowIso = new Date().toISOString();

const search = await createSearcher().catch(exitOnConfigError);

const [posts, pending, denied] = await Promise.all([
  readPosts(), readPending(), readDenied(),
]);

// Applied at load rather than only when a query re-surfaces the post: a query
// that stops early, or a post that has since been deleted, would otherwise leave
// a denied entry in the archive indefinitely.
const byUri = new Map(posts.filter((p) => !denied.has(p.uri)).map((p) => [p.uri, p]));
const pendingByUri = new Map(
  pending.filter((p) => !denied.has(p.uri)).map((p) => [p.uri, p]),
);

// Reclassify the queue against the current matcher before searching. Promotion
// otherwise only happens when a query re-surfaces the post, so loosening the
// matcher (as adding "MI" did) would strand older queued posts it now accepts.
// The text is stored, so this costs nothing.
let promoted = 0;
let dropped = 0;
for (const [uri, queued] of pendingByUri) {
  const kind = classify(queued.text);
  if (kind === "variant") continue;

  pendingByUri.delete(uri);
  if (kind === "ignore") {
    // A tightened matcher would otherwise strand an entry here permanently:
    // nothing else removes it, and the queue-holds-only-variants invariant would
    // fail on every run afterwards.
    dropped++;
    continue;
  }
  if (byUri.has(uri)) continue;
  const { matchedQuery: _matchedQuery, ...post } = queued;
  byUri.set(uri, post);
  promoted++;
}
if (promoted > 0) console.log(`promoted ${promoted} queued post(s) under the current matcher`);
if (dropped > 0) console.log(`dropped ${dropped} queued post(s) the matcher no longer accepts`);

// Every query is swept in full, every run. It is a handful of requests and it
// self-heals, picking up posts that were briefly private, late to index, or from
// since-unblocked accounts without any special case. The variant query used to
// run against a `since` watermark instead, which mattered when anonymous search
// was capped at one page; authenticated it returns its whole result set in two
// requests, so the watermark bought one request per run and cost a state file, a
// truncation signal, and the rule tying them together.
//
// The two lists differ only in what classify() does with what they return, so
// they sweep identically -- the label is for the log.
const SWEEPS = [
  { label: "exact", queries: EXACT_QUERIES },
  { label: "variant", queries: VARIANT_QUERIES },
];

const results: Array<{ query: string; posts: SearchPostView[] }> = [];
for (const { label, queries } of SWEEPS) {
  for (const query of queries) {
    console.log(`${label} sweep: ${query}`);
    results.push({ query, posts: await runQuery(search, query) });
  }
}

let newExact = 0;
let newPending = 0;

for (const { query, posts: found } of results) {
  for (const p of found) {
    const kind = classify(postText(p));
    if (kind === "ignore") continue;

    // denied is a moderation escape hatch and must outrank an exact match:
    // otherwise a post you removed is re-added by the next sweep, forever. The
    // maps were filtered at load, so this only has to block the re-add.
    if (denied.has(p.uri)) continue;

    if (kind === "exact") {
      // A post promoted to exact leaves the review queue; re-running the
      // matcher over stored text can reclassify without re-querying. Its
      // firstSeenAt carries over: the field records when the collector first
      // saw the post, which is when it entered the queue, not when review ended.
      const queued = pendingByUri.get(p.uri);
      pendingByUri.delete(p.uri);
      // Never overwrite an existing entry. Beyond avoiding pointless churn, this
      // is what makes createdAt/indexedAt -- and so the feed's sort key -- fixed
      // for the life of a URI. The pagination cursor encodes that key as a
      // position, so a key that moved would drop or repeat everything after it
      // for any client mid-walk.
      if (byUri.has(p.uri)) continue;
      byUri.set(p.uri, toStored(p, queued?.firstSeenAt ?? nowIso));
      newExact++;
      continue;
    }

    // variant
    if (byUri.has(p.uri) || pendingByUri.has(p.uri)) continue;
    pendingByUri.set(p.uri, { ...toStored(p, nowIso), matchedQuery: query });
    newPending++;
  }
}

await Promise.all([
  writePosts([...byUri.values()]),
  writePending([...pendingByUri.values()]),
]);

console.log(
  `\n${byUri.size} posts (+${newExact + promoted}), ${pendingByUri.size} pending (+${newPending})`,
);

// Consumed by the workflow to decide whether to open a review issue, and to
// title it.
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `new_pending=${newPending}\nnew_posts=${newExact + promoted}\n`,
  );
}
