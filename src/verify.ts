import { FEED_DID, FEED_URI, HOSTNAME } from "./config.ts";
import { getJson, isJson } from "./lib/http.ts";
import { entriesOf } from "./lib/order.ts";
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

const skeletonUrl = (params: Record<string, string>) => {
  const u = new URL(`https://${HOSTNAME}/xrpc/app.bsky.feed.getFeedSkeleton`);
  u.searchParams.set("feed", FEED_URI);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * The skeleton is a Cloud Function, so the first request after a deploy pays a
 * cold start. One retry keeps that from reddening the collection loop; a second
 * 5xx is a real failure.
 */
async function getSkeleton(url: string) {
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
  const res = await getSkeleton(path);
  check(res.status === 200, `${name} reachable`, `HTTP ${res.status}`);
  check(isJson(res.type), `${name} content type`, res.type || "(none)");
  for (const [ok, label, detail] of extra(res.body)) check(ok, `${name} ${label}`, String(detail ?? ""));
}

// `feed` is required by the lexicon, so a request without it must be rejected --
// and a feed we do not serve must be rejected as UnknownFeed rather than silently
// answered with ours.
{
  const bare = await getJson(`https://${HOSTNAME}/xrpc/app.bsky.feed.getFeedSkeleton`);
  check(bare.status === 400, "rejects a request with no feed param", `HTTP ${bare.status}`);
  const other = new URL(`https://${HOSTNAME}/xrpc/app.bsky.feed.getFeedSkeleton`);
  other.searchParams.set("feed", "at://did:plc:nobody/app.bsky.feed.generator/other");
  const wrong = await getJson(other.toString());
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
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let ok = true;

  for (;;) {
    const res = await getSkeleton(skeletonUrl({
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    }));
    pages++;
    if (res.status !== 200) {
      check(false, "walk page reachable", `page ${pages}: HTTP ${res.status}`);
      ok = false;
      break;
    }
    const body = res.body as { feed?: { post: string }[]; cursor?: string };
    // An echoed cursor is read by the AppView as end-of-feed, so it would truncate
    // the feed at this page for every subscriber.
    if (body.cursor !== undefined && body.cursor === cursor) {
      check(false, "walk never echoes its cursor", `page ${pages}`);
      ok = false;
      break;
    }
    seen.push(...(body.feed ?? []).map((f) => f.post));
    if (body.cursor === undefined) break;
    cursor = body.cursor;
    if (pages >= maxPages) {
      check(false, "walk terminates", `still paging after ${pages} pages`);
      ok = false;
      break;
    }
  }

  if (ok) {
    check(pages === Math.ceil(expected.length / limit), "walk takes the expected number of pages",
      `${pages} pages for ${expected.length} posts at limit ${limit}`);
    check(new Set(seen).size === seen.length, "walk repeats no post",
      `${seen.length - new Set(seen).size} duplicate(s)`);
    check(seen.length === expected.length, "walk reaches every archived post",
      `${seen.length} of ${expected.length}`);
    check(seen.join() === expected.join(), "walk matches the archive's order");
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
