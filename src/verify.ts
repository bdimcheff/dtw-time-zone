import {
  FEED_DESCRIPTION, FEED_DID, FEED_NAME, FEED_RKEY, FEED_URI, HOSTNAME, PUBLISHER_DID,
} from "./config.ts";
import { getJson, isJson } from "./lib/http.ts";
import { entriesOf } from "./lib/order.ts";
import type { Page } from "./lib/skeleton.ts";
import { WalkError, urisOf, walkFeed } from "./lib/skeleton.ts";
import { readPosts } from "./lib/store.ts";

/**
 * Post-deploy smoke test. Each of these failures makes the feed break in a way
 * that is hard to trace from the Bluesky app: a wrong content type, a missing
 * .well-known, or a skeleton that ends after one page just renders as an empty,
 * unavailable, or mysteriously short feed.
 */

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** Reported, not counted: we could not determine the answer, which is not a no. */
const unknown = (label: string, detail: string) => {
  console.log(`~ ${label} — ${detail}`);
};

/** Omit `feed` for the malformed-request checks; it defaults to ours. */
const skeletonUrl = (params: Record<string, string> = {}, feed: string | null = FEED_URI) => {
  const u = new URL(`https://${HOSTNAME}/xrpc/app.bsky.feed.getFeedSkeleton`);
  if (feed !== null) u.searchParams.set("feed", feed);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * The skeleton is a Cloud Function, so the first request after a deploy pays a
 * cold start. One retry keeps that from reddening the collection loop; a second
 * 5xx is a real failure.
 */
async function getWithRetry(url: string) {
  const first = await getJson(url);
  if (first.status < 500 && first.status !== 0) return first;
  await new Promise((r) => setTimeout(r, 2000));
  return getJson(url);
}

/** Endpoint-specific assertions; reachability and content type are checked for all. */
const ENDPOINTS = [
  {
    name: "did.json",
    path: `https://${HOSTNAME}/.well-known/did.json`,
    extra: (body: any) => [
      [body?.id === FEED_DID, "declares the right DID", body?.id] as const,
    ],
  },
  {
    // The AppView's XRPC client rejects responses that aren't declared as JSON.
    // This one is served by the function, which sets its own content type -- the
    // firebase.json headers rule no longer covers this path.
    name: "getFeedSkeleton",
    path: skeletonUrl({ limit: "5" }),
    extra: (body: any) => [
      [Array.isArray(body?.feed) && body.feed.length > 0, "returns posts",
       `${body?.feed?.length ?? 0} entries`] as const,
    ],
  },
  {
    // Still a static file, and still extensionless, so firebase.json forces its
    // content type.
    name: "describeFeedGenerator",
    path: `https://${HOSTNAME}/xrpc/app.bsky.feed.describeFeedGenerator`,
    extra: () => [],
  },
];

for (const { name, path, extra } of ENDPOINTS) {
  const res = await getWithRetry(path);
  check(res.status === 200, `${name} reachable`, `HTTP ${res.status}`);
  check(isJson(res.type), `${name} content type`, res.type || "(none)");
  for (const [ok, label, detail] of extra(res.body)) check(ok, `${name} ${label}`, String(detail ?? ""));
}

// `feed` is required by the lexicon, so a request without it must be rejected --
// and a feed we do not serve must be rejected as UnknownFeed rather than silently
// answered with ours.
{
  const bare = await getJson(skeletonUrl({}, null));
  check(bare.status === 400, "rejects a request with no feed param", `HTTP ${bare.status}`);
  const wrong = await getJson(
    skeletonUrl({}, "at://did:plc:nobody/app.bsky.feed.generator/other"),
  );
  check(
    wrong.status === 400 && (wrong.body as any)?.error === "UnknownFeed",
    "rejects an unknown feed",
    `HTTP ${wrong.status} ${(wrong.body as any)?.error ?? ""}`,
  );
}

/**
 * The whole point of #2: walk the cursor to exhaustion and confirm subscribers can
 * reach the entire archive. Asserted against the local data rather than against
 * itself, because the failure this catches is the endpoint serving a stale or
 * truncated list, which self-consistency would not reveal.
 */
{
  const expected = entriesOf(await readPosts()).map((e) => e.uri);
  const limit = 10;
  const maxPages = Math.ceil(expected.length / limit) + 3;

  /** One page over HTTP, shaped for the shared walker. */
  const fetchPage = async (cursor: string | undefined): Promise<Page> => {
    const res = await getWithRetry(
      skeletonUrl({ limit: String(limit), ...(cursor ? { cursor } : {}) }),
    );
    if (res.status !== 200) throw new WalkError(`HTTP ${res.status}`, 0);
    const body = res.body as Partial<Page>;
    return { feed: body.feed ?? [], ...(body.cursor !== undefined ? { cursor: body.cursor } : {}) };
  };

  // The same walker the tests run against the local paginator, so the endpoint
  // is held to exactly the contract skeleton.test.ts asserts. It throws on an
  // echoed cursor or a walk that will not terminate -- both of which the AppView
  // reads as end-of-feed, truncating the feed for every subscriber.
  let pages: Page[] | undefined;
  try {
    pages = await walkFeed(fetchPage, maxPages);
  } catch (err) {
    check(false, "walk completes", err instanceof WalkError ? err.message : String(err));
  }

  if (pages) {
    const seen = urisOf(pages);
    check(pages.length === Math.ceil(expected.length / limit), "walk takes the expected number of pages",
      `${pages.length} pages for ${expected.length} posts at limit ${limit}`);
    check(new Set(seen).size === seen.length, "walk repeats no post",
      `${seen.length - new Set(seen).size} duplicate(s)`);
    check(seen.length === expected.length, "walk reaches every archived post",
      `${seen.length} of ${expected.length}`);
    check(seen.join() === expected.join(), "walk matches the archive's order");
  }
}

/**
 * The feed's display metadata lives in two places that nothing reconciles:
 * config.ts, and the app.bsky.feed.generator record `npm run publish-record`
 * wrote. Editing FEED_NAME or FEED_DESCRIPTION changes only the first, and
 * Bluesky keeps serving the old text with every other check here still green --
 * the same shape as the rest of this file's failures.
 *
 * A record we cannot read is reported as unknown rather than as a failure. This
 * runs after every collection, ~17,500 times a year, and its subject is two
 * strings that change by hand perhaps twice in the feed's life; a bsky.social
 * blip must not redden the loop over that. A mismatch -- the thing actually
 * worth knowing -- still fails. Unlike isValid/isOnline below, this check can
 * say no.
 */
{
  const url = new URL("https://bsky.social/xrpc/com.atproto.repo.getRecord");
  url.searchParams.set("repo", PUBLISHER_DID);
  url.searchParams.set("collection", "app.bsky.feed.generator");
  url.searchParams.set("rkey", FEED_RKEY);

  const res = await getJson(url.toString());
  const record = (res.body as { value?: { displayName?: string; description?: string } })?.value;

  if (res.status !== 200 || !record) {
    unknown("feed record matches config.ts", `could not read the record (HTTP ${res.status})`);
  } else {
    check(record.displayName === FEED_NAME, "feed record name matches config.ts",
      record.displayName ?? "(none)");
    check(record.description === FEED_DESCRIPTION, "feed record description matches config.ts",
      record.description === FEED_DESCRIPTION ? "" : "stale — run npm run publish-record");
  }
}

// Note: getFeedGenerator's isValid/isOnline are NOT checked. The AppView hard-codes
// both to true (packages/bsky/.../getFeedGenerator.ts, with a @TODO saying the
// describeFeedGenerator probe was never shipped), so they cannot fail -- not on a
// 502, not if this endpoint were deleted outright. Asserting them looked like a
// liveness guard while providing none. The walk above is the liveness guard.

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
