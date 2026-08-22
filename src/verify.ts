import { APPVIEW, FEED_DID, FEED_RKEY, HOSTNAME, PUBLISHER_DID } from "./config.ts";
import { getJson, isJson } from "./lib/http.ts";

/**
 * Post-deploy smoke test. Each of these failures makes the feed break in a way
 * that is hard to trace from the Bluesky app: a wrong content type or a missing
 * .well-known just renders as an empty or unavailable feed.
 */

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** Endpoint-specific assertions; reachability and content type are checked for all. */
const ENDPOINTS = [
  {
    name: "did.json",
    path: "/.well-known/did.json",
    extra: (body: any) => [
      [body?.id === FEED_DID, "declares the right DID", body?.id] as const,
    ],
  },
  {
    // The AppView's XRPC client rejects responses that aren't declared as JSON,
    // and Firebase infers octet-stream for these extensionless paths by default.
    name: "getFeedSkeleton",
    path: "/xrpc/app.bsky.feed.getFeedSkeleton",
    extra: (body: any) => [
      [Array.isArray(body?.feed) && body.feed.length > 0, "returns posts",
       `${body?.feed?.length ?? 0} entries`] as const,
    ],
  },
  { name: "describeFeedGenerator", path: "/xrpc/app.bsky.feed.describeFeedGenerator", extra: () => [] },
];

for (const { name, path, extra } of ENDPOINTS) {
  const res = await getJson(`https://${HOSTNAME}${path}`);
  check(res.status === 200, `${name} reachable`, `HTTP ${res.status}`);
  check(isJson(res.type), `${name} content type`, res.type || "(none)");
  for (const [ok, label, detail] of extra(res.body)) check(ok, `${name} ${label}`, String(detail ?? ""));
}

// Only present once publish-record.ts has run; absence is reported, not fatal.
const feedUri = `at://${PUBLISHER_DID}/app.bsky.feed.generator/${FEED_RKEY}`;
const gen = await getJson(
  `${APPVIEW}/xrpc/app.bsky.feed.getFeedGenerator?feed=${encodeURIComponent(feedUri)}`,
);
if (gen.status === 200) {
  const view = gen.body as { isValid?: boolean; isOnline?: boolean };
  check(view.isValid !== false, "AppView considers the feed valid");
  check(view.isOnline !== false, "AppView considers the feed online");
} else {
  console.log(`· feed record not published yet (HTTP ${gen.status}) — run npm run publish-record`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
