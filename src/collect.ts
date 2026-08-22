import {
  EXACT_QUERY,
  VARIANT_QUERIES,
  WINDOW_OVERLAP_DAYS,
  FULL_SWEEP_INTERVAL_DAYS,
} from "./config.ts";
import { createSearcher } from "./lib/bsky.ts";
import type { Searcher, SearchOptions, SearchResult } from "./lib/bsky.ts";
import { classify, postText } from "./lib/match.ts";
import {
  readPosts, readPending, readDenied, readState,
  writePosts, writePending, writeState,
} from "./lib/store.ts";
import type { StoredPost, PendingPost, SearchPostView } from "./lib/types.ts";

const DAY_MS = 86_400_000;

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
 * before anything is written, so an unguarded throw from the last variant query
 * threw away the exact sweep's results too, then failed the workflow before Build
 * and Deploy. A failed query counts as truncated: its window went uncovered.
 */
async function runQuery(
  search: Searcher,
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult> {
  try {
    return await search(query, opts);
  } catch (err) {
    console.error(`  query failed: ${query}\n    ${(err as Error).message}`);
    return { posts: [], truncated: true };
  }
}

async function main(): Promise<void> {
  const forceFullSweep = process.argv.includes("--full");
  const now = new Date();
  const nowIso = now.toISOString();

  const search = await createSearcher();

  const [posts, pending, denied, state] = await Promise.all([
    readPosts(), readPending(), readDenied(), readState(),
  ]);

  // Applied at load rather than only when a query re-surfaces the post: variant
  // queries run windowed and the exact query is capped, so an older archived post
  // added to denied.json may never appear in a result set again.
  const byUri = new Map(posts.filter((p) => !denied.has(p.uri)).map((p) => [p.uri, p]));
  const pendingByUri = new Map(
    pending.filter((p) => !denied.has(p.uri)).map((p) => [p.uri, p]),
  );

  // The exact query returns a single page, so sweeping it fully every run costs
  // one request and is self-healing: posts that were briefly private, late to
  // index, or from since-unblocked accounts get picked up without special cases.
  const results: Array<{ query: string; posts: SearchPostView[]; truncated: boolean }> = [];
  console.log(`exact sweep: ${EXACT_QUERY}`);
  results.push({ query: EXACT_QUERY, ...(await runQuery(search, EXACT_QUERY)) });

  // Variant queries paginate through years of sincere timezone discussion, so
  // they run windowed except during a periodic full sweep.
  const lastSweep = state.lastFullSweepAt ? Date.parse(state.lastFullSweepAt) : 0;
  const sweepDue = now.getTime() - lastSweep > FULL_SWEEP_INTERVAL_DAYS * DAY_MS;
  const fullSweep = forceFullSweep || sweepDue;

  // Widened rather than trusted exactly: since/until filter on `sortAt`, which
  // the lexicon warns may not match `createdAt`. Dedupe makes the overlap free.
  const since = fullSweep || !state.lastRunAt
    ? undefined
    : new Date(Date.parse(state.lastRunAt) - WINDOW_OVERLAP_DAYS * DAY_MS).toISOString();

  // Only the variant queries read `since`, so only their truncation can invalidate
  // the watermark; the exact query re-sweeps unwindowed every run regardless.
  let windowTruncated = false;
  console.log(fullSweep ? "variant queries: FULL sweep" : `variant queries: since ${since}`);
  for (const query of VARIANT_QUERIES) {
    const result = await runQuery(search, query, { since });
    if (result.truncated) windowTruncated = true;
    results.push({ query, ...result });
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
    writePending([...pendingByUri.values()] as PendingPost[]),
    // A truncated query means posts inside the window were never examined.
    // Advancing the watermark past them moves the next run's `since` beyond posts
    // nothing ever read, and the output looks identical to a clean run. Hold it
    // instead. On the anonymous path, where every query is capped at page 1, this
    // is the normal case rather than an edge case.
    writeState({
      lastRunAt: windowTruncated ? state.lastRunAt : nowIso,
      lastFullSweepAt: fullSweep && !windowTruncated ? nowIso : state.lastFullSweepAt,
    }),
  ]);

  console.log(
    `\n${byUri.size} posts (+${newExact}), ${pendingByUri.size} pending (+${newPending})`,
  );
  if (windowTruncated) {
    console.warn("  window not fully covered; holding lastRunAt so the next run re-reads it");
  }

  // Consumed by the workflow to decide whether to open a review PR.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `new_pending=${newPending}\nnew_posts=${newExact}\ntotal_pending=${pendingByUri.size}\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
